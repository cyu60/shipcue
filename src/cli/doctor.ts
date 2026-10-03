// `npx shipcue doctor` (shipcue report 5fdbd60f): run in an app's repo, it reads what it needs
// (package.json, node_modules, lockfiles, the route, .env files, `vercel env ls`, optionally the
// live endpoint and the database) and prints a ✓/✗ line per check with the exact fix.
// Never prints a secret's value. Everything outside can be swapped in for tests.
//   npx shipcue doctor [--url https://app/api/shipcue] [--route <file>] [--env A,B] [--offline] [--no-db]

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  REPO,
  checkAgentApi,
  checkCapabilities,
  checkDatabase,
  checkEnv,
  checkInstalled,
  checkLockfiles,
  checkRoute,
  envKeys,
  exitCode,
  formatResults,
  handlerEnvVars,
  parseSchema,
  parseVercelEnvLs,
  type CheckResult,
  type DbState,
  type EnvSource,
} from './checks';

export interface DoctorOptions {
  cwd: string;
  args: string[];
  /** The text of sql/schema.sql from this copy of shipcue. */
  schemaSql: string;
  env?: Record<string, string | undefined>;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Runs a command and returns its stdout (throws if it fails). */
  exec?: (cmd: string, args: string[], cwd: string) => Promise<string>;
  queryDb?: (databaseUrl: string, tables: string[]) => Promise<DbState>;
}

const ENV_FILES = ['.env', '.env.local', '.env.development', '.env.development.local', '.env.production', '.env.production.local'];

export const flagValue = (args: string[], name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

const read = (p: string) => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return undefined;
  }
};

/** Reads one env var's value from the shell or the .env files, to use (never to print). */
function envValue(name: string, cwd: string, env: Record<string, string | undefined>): string | undefined {
  if (env[name]) return env[name];
  for (const f of [...ENV_FILES].reverse()) {
    const m = read(join(cwd, f))?.match(new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*)$`, 'm'));
    const v = m?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2');
    if (v) return v;
  }
  return undefined;
}

const defaultExec = (cmd: string, args: string[], cwd: string) =>
  new Promise<string>((resolve, reject) =>
    execFile(cmd, args, { cwd, timeout: 20_000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout)))),
  );

/** Uses the app's own `pg` (no dependency of shipcue's own); read-only queries. */
function defaultQueryDb(cwd: string) {
  return async (databaseUrl: string, tables: string[]): Promise<DbState> => {
    const req = createRequire(join(cwd, 'package.json'));
    let pg: { Client: new (o: object) => { connect(): Promise<void>; query(q: string, v?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>; end(): Promise<void> } };
    try {
      pg = req('pg');
    } catch {
      throw new Error('install pg in this app to check the tables (shipcue uses the app\'s own driver)');
    }
    const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 8000 });
    await client.connect();
    try {
      const cols = await client.query(
        `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ANY($1)`,
        [tables],
      );
      const rls = await client.query(
        `SELECT relname, relrowsecurity FROM pg_class WHERE relnamespace = current_schema()::regnamespace AND relname = ANY($1)`,
        [tables],
      );
      const check = await client.query(
        `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
         WHERE t.relnamespace = current_schema()::regnamespace AND c.conname = 'shipcue_report_events_action_check'`,
      );
      return {
        columns: cols.rows.map((r) => ({ table: String(r.table_name), column: String(r.column_name) })),
        rls: rls.rows.map((r) => ({ table: String(r.relname), on: Boolean(r.relrowsecurity) })),
        actionCheck: check.rows[0] ? String(check.rows[0].def) : null,
      };
    } finally {
      await client.end();
    }
  };
}

async function status(doFetch: NonNullable<DoctorOptions['fetch']>, url: string, init?: RequestInit) {
  try {
    const res = await doFetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* not JSON */
    }
    return { status: res.status, body };
  } catch {
    return { status: null, body: null };
  }
}

export async function runDoctor(o: DoctorOptions): Promise<{ output: string; code: number }> {
  const { cwd, args } = o;
  const env = o.env ?? process.env;
  const doFetch = o.fetch ?? ((u: string, i?: RequestInit) => fetch(u, i));
  const exec = o.exec ?? defaultExec;
  const offline = args.includes('--offline');
  const results: CheckResult[] = [];

  // 1. Installed, and the newest release.
  const pkg = JSON.parse(read(join(cwd, 'package.json')) ?? '{}') as Record<string, Record<string, string> | undefined>;
  const declared = pkg.dependencies?.shipcue ?? pkg.devDependencies?.shipcue;
  const installed = (JSON.parse(read(join(cwd, 'node_modules/shipcue/package.json')) ?? '{}') as { version?: string }).version;
  let latest: string | null | undefined;
  if (installed) {
    latest = null;
    if (!offline) {
      const r = await status(doFetch, `https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: 'application/vnd.github+json' } });
      const tag = (r.body as { tag_name?: unknown } | null)?.tag_name;
      if (r.status === 200 && typeof tag === 'string') latest = tag;
    }
  }
  results.push(...checkInstalled({ declared, installed, latest }));

  // 2. The lockfile trap.
  const pinned = declared?.match(/\/download\/v([^/]+)\//)?.[1];
  const lockfiles = ['pnpm-lock.yaml', 'package-lock.json', 'package.json']
    .map((name) => ({ name, text: read(join(cwd, name)) ?? '' }))
    .filter((f) => f.text);
  results.push(checkLockfiles(lockfiles, pinned ?? installed));

  // 3. The handler route.
  const routeFlag = flagValue(args, '--route');
  const route = checkRoute((p) => existsSync(join(cwd, p)), routeFlag);
  results.push(route);
  const routeText = route.status === 'ok' ? read(join(cwd, route.detail!)) : undefined;

  // 4. Env vars the handler reads: .env files, the shell, and Vercel when the project is linked.
  const names = flagValue(args, '--env')?.split(',').map((s) => s.trim()).filter(Boolean) ?? handlerEnvVars(routeText);
  const sources: EnvSource[] = [];
  for (const f of ENV_FILES) {
    const text = read(join(cwd, f));
    if (text !== undefined) sources.push({ label: f, keys: envKeys(text) });
  }
  sources.push({ label: 'your shell', keys: new Set(names.filter((n) => env[n])) });
  if (existsSync(join(cwd, '.vercel/project.json'))) {
    try {
      sources.push({ label: 'Vercel', keys: parseVercelEnvLs(await exec('vercel', ['env', 'ls'], cwd)) });
    } catch {
      results.push({ status: 'skip', title: 'Vercel env', detail: 'project is linked but `vercel env ls` failed (install or log in to the vercel CLI)' });
    }
  }
  results.push(...checkEnv(names, sources));

  // 5. Live: the endpoint, the agent API and the tables.
  const url = flagValue(args, '--url')?.replace(/\/+$/, '');
  if (!url && !args.includes('--db')) {
    results.push({ status: 'skip', title: 'Live checks', detail: 'pass --url https://your-app/api/shipcue to check the endpoint, the token and the tables' });
    return { output: formatResults(results), code: exitCode(results) };
  }
  if (url) {
    const caps = await status(doFetch, `${url}/capabilities`);
    results.push(checkCapabilities(caps.status, caps.body));
    const token = envValue('SHIPCUE_TOKEN', cwd, env);
    const agent = token ? await status(doFetch, `${url}/reports?status=open`, { headers: { authorization: `Bearer ${token}` } }) : undefined;
    results.push(checkAgentApi(agent?.status));
  }
  const dbVar = names.find((n) => /DATABASE|POSTGRES|DB_URL/.test(n)) ?? 'DATABASE_URL';
  const databaseUrl = envValue(dbVar, cwd, env);
  if (args.includes('--no-db')) results.push({ status: 'skip', title: 'Tables', detail: 'skipped (--no-db)' });
  else if (!databaseUrl) results.push({ status: 'skip', title: 'Tables', detail: `no ${dbVar} to connect with` });
  else {
    const schema = parseSchema(o.schemaSql);
    try {
      const db = await (o.queryDb ?? defaultQueryDb(cwd))(databaseUrl, [...schema.tables.keys()]);
      results.push(...checkDatabase(schema, db));
    } catch (err) {
      const msg = err instanceof Error ? err.message.replaceAll(databaseUrl, '<url>') : 'failed';
      results.push({ status: 'fail', title: 'Tables', detail: `could not connect with ${dbVar}`, fix: msg });
    }
  }
  return { output: formatResults(results), code: exitCode(results) };
}
