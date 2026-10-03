// The checks behind `npx shipcue doctor` (shipcue report 5fdbd60f). Pure functions: they take
// what doctor.ts read (files, HTTP statuses, rows from the database) and say ✓ or ✗, with the
// exact fix for each ✗. Nothing here reads a file, the network or the environment.

export type Status = 'ok' | 'fail' | 'warn' | 'skip';
export interface CheckResult {
  status: Status;
  title: string;
  detail?: string;
  /** What to run or change, shown indented under a ✗ or !. */
  fix?: string;
}

export const REPO = 'cyu60/shipcue';
const MARK: Record<Status, string> = { ok: '✓', fail: '✗', warn: '!', skip: '–' };

export function formatResults(results: CheckResult[]): string {
  let out = '';
  for (const r of results) {
    out += `${MARK[r.status]} ${r.title}${r.detail ? `: ${r.detail}` : ''}\n`;
    if (r.fix && (r.status === 'fail' || r.status === 'warn')) out += r.fix.split('\n').map((l) => `    ${l}`.trimEnd()).join('\n') + '\n';
  }
  return out;
}

export const exitCode = (results: CheckResult[]) => (results.some((r) => r.status === 'fail') ? 1 : 0);

export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/, '').split(/[.-]/).map((p) => parseInt(p, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export const stableReleaseUrl = (version: string) => {
  const v = version.replace(/^v/, '');
  return `https://github.com/${REPO}/releases/download/v${v}/shipcue-${v}.tgz`;
};

const INSTALL_FIX = `npm i shipcue   (or pnpm add shipcue, once it is on npm)
until it's on npm: pnpm add ${stableReleaseUrl('<version>')}
  (versions: https://github.com/${REPO}/releases)`;

export function checkInstalled(o: { declared?: string; installed?: string; latest?: string | null }): CheckResult[] {
  if (!o.installed) {
    return [
      o.declared
        ? { status: 'fail', title: 'shipcue installed', detail: `in package.json (${o.declared}) but not in node_modules`, fix: 'run your install (pnpm install / npm install)' }
        : { status: 'fail', title: 'shipcue installed', detail: 'not found', fix: INSTALL_FIX },
    ];
  }
  const out: CheckResult[] = [{ status: 'ok', title: 'shipcue installed', detail: o.installed }];
  if (o.latest === undefined) return out;
  if (o.latest === null) out.push({ status: 'skip', title: 'Newest release', detail: 'not checked (offline)' });
  else if (compareVersions(o.installed, o.latest) < 0) {
    const v = o.latest.replace(/^v/, '');
    out.push({ status: 'warn', title: 'Newest release', detail: `${v} is out`, fix: `pnpm add ${stableReleaseUrl(v)}\n(or npm i shipcue@${v} once it is on npm; then run the "Upgrading from" lines in sql/schema.sql it needs)` });
  }
  return out;
}

// GitHub's signed download URL, as pnpm writes it after following the release redirect. It expires
// in about an hour, so every deploy after that fails. Stops before the `(react@…)` peer suffix and
// the trailing `:` of a lockfile key.
const SIGNED_URL = /https:\/\/release-assets\.githubusercontent\.com\/[^\s}(),:'"]+/g;

export const findSignedUrls = (text: string) => text.match(SIGNED_URL) ?? [];
export const swapSignedUrls = (text: string, stable: string) => text.replace(SIGNED_URL, stable);

export function checkLockfiles(files: { name: string; text: string }[], version?: string): CheckResult {
  const hits = files.map((f) => ({ name: f.name, n: findSignedUrls(f.text).length })).filter((f) => f.n);
  if (!hits.length) return { status: 'ok', title: 'No signed release URLs in the lockfile' };
  const stable = stableReleaseUrl(version ?? '<version>');
  const names = hits.map((h) => h.name);
  return {
    status: 'fail',
    title: 'Signed release URLs in the lockfile',
    detail: hits.map((h) => `${h.name} (${h.n})`).join(', '),
    fix: [
      `GitHub's signed download URL expires in about an hour; later deploys fail (ERR_PNPM_FETCH_618).`,
      `Swap only the URL for the stable one:`,
      `  perl -pi -e 's#https://release-assets\\.githubusercontent\\.com/[^\\s}(),:\\x27"]+#${stable}#g' ${names.join(' ')}`,
      names.includes('package-lock.json') ? `  npm ci` : `  pnpm install --frozen-lockfile`,
      `Once shipcue is on npm, npm i shipcue removes the trap for good.`,
    ].join('\n'),
  };
}

export const ROUTE_CANDIDATES = ['ts', 'js', 'tsx', 'mjs'].flatMap((ext) =>
  ['app', 'src/app'].map((dir) => `${dir}/api/shipcue/[...path]/route.${ext}`),
);

export function checkRoute(exists: (path: string) => boolean, configured?: string): CheckResult {
  const found = configured ? (exists(configured) ? configured : undefined) : ROUTE_CANDIDATES.find(exists);
  if (found) return { status: 'ok', title: 'Handler route', detail: found };
  return {
    status: 'fail',
    title: 'Handler route',
    detail: configured ? `${configured} not found` : 'not found',
    fix: `Next.js: create app/api/shipcue/[...path]/route.ts with createShipcueHandler
and export { handler as GET, handler as POST } (README, "2. Mount the handler").
Mounted somewhere else? pass --route <file>.`,
  };
}

/** Keys that have a value in a .env file. Values are never kept. */
export function envKeys(text: string): Set<string> {
  const keys = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m && m[2]!.trim().replace(/^(['"])\1$/, '') !== '') keys.add(m[1]!);
  }
  return keys;
}

export const DEFAULT_ENV = ['DATABASE_URL', 'SHIPCUE_TOKEN'];

/** The env vars the route reads (process.env.X or process.env['X']), or the usual two. */
export function handlerEnvVars(routeText: string | undefined): string[] {
  const found: string[] = [];
  for (const m of (routeText ?? '').matchAll(/process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\])/g)) {
    const name = (m[1] ?? m[2])!;
    if (!found.includes(name)) found.push(name);
  }
  return found.length ? found : [...DEFAULT_ENV];
}

/** Names and environments from `vercel env ls` (whose values column only ever says Encrypted). */
export function parseVercelEnvLs(stdout: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const cols = line.trim().split(/\s{2,}/);
    if (cols.length >= 3 && /^[A-Z_][A-Z0-9_]*$/.test(cols[0]!)) out.set(cols[0]!, cols[2]!);
  }
  return out;
}

export interface EnvSource {
  label: string;
  /** A Map is Vercel's (name → environments); a Set is a file or the shell. */
  keys: Set<string> | Map<string, string>;
}

const howToGet = (name: string) =>
  /TOKEN/.test(name)
    ? `${name}=$(openssl rand -hex 32)   (the agent API stays off without it; give agents the same value)`
    : /DATABASE|POSTGRES|DB_URL/.test(name)
      ? `${name}=postgres://…   (your Postgres connection string: Supabase, Neon, InsForge, RDS…)`
      : `${name}=…`;

export function checkEnv(names: string[], sources: EnvSource[]): CheckResult[] {
  const vercel = sources.find((s) => s.keys instanceof Map);
  return names.map((name): CheckResult => {
    const where = sources.filter((s) => s.keys.has(name));
    const vercelFix = `vercel env add ${name} production   (and preview), then redeploy`;
    if (!where.length) {
      return { status: 'fail', title: name, detail: 'not set', fix: [`add to .env.local: ${howToGet(name)}`, vercel ? vercelFix : `and to your host's environment, then redeploy`].join('\n') };
    }
    if (vercel && !vercel.keys.has(name)) {
      return { status: 'fail', title: name, detail: `in ${where.map((s) => s.label).join(', ')}, not on Vercel`, fix: vercelFix };
    }
    const labels = where.map((s) => (s.keys instanceof Map ? `${s.label} (${s.keys.get(name)})` : s.label));
    return { status: 'ok', title: name, detail: `in ${labels.join(', ')}` };
  });
}

export function checkCapabilities(status: number | null, body: unknown): CheckResult {
  const title = 'GET /capabilities';
  if (status === 200 && body && typeof body === 'object') return { status: 'ok', title, detail: '200' };
  if (status === null) return { status: 'fail', title, detail: 'could not reach it', fix: 'check the --url (it is where the handler is mounted, e.g. https://app/api/shipcue) and that the app is deployed' };
  return {
    status: 'fail',
    title,
    detail: String(status),
    fix: status === 404
      ? 'the handler route is not deployed at this URL: check the route file and basePath (default /api/shipcue), then redeploy'
      : 'see the server logs; a 500 here is usually a missing env var or an unreachable database',
  };
}

export function checkAgentApi(status: number | null | undefined): CheckResult {
  const title = 'Agent API';
  if (status === undefined) return { status: 'skip', title, detail: 'no SHIPCUE_TOKEN to try' };
  if (status === 200) return { status: 'ok', title, detail: '200 with SHIPCUE_TOKEN' };
  if (status === 401) return { status: 'fail', title, detail: '401', fix: 'the deployed SHIPCUE_TOKEN differs from yours: set the same value on the host and redeploy' };
  if (status === 404) return { status: 'fail', title, detail: '404', fix: 'the agent API is off: pass agentToken: process.env.SHIPCUE_TOKEN to createShipcueHandler and set it on the host' };
  return { status: 'fail', title, detail: status === null ? 'could not reach it' : String(status), fix: 'see the server logs (GET /reports?status=open)' };
}

export interface Schema {
  /** Table → where it is created, and each column → the block that adds it. */
  tables: Map<string, { block: string; columns: Map<string, string> }>;
  /** The newest allowed list of history actions, and the block that sets it. */
  actionCheck?: { values: string[]; block: string };
}

/**
 * Reads sql/schema.sql: its first part creates the tables, then each "-- Upgrading from …" block
 * adds what a release needs. Every column is traced to the block that adds it, so the doctor can
 * print just the blocks a database is missing.
 */
export function parseSchema(sql: string): Schema {
  const blocks: string[] = [];
  let current: string[] = [];
  for (const line of sql.split('\n')) {
    if (/^-- Upgrading from /.test(line) && current.length) {
      blocks.push(current.join('\n').trim());
      current = [];
    }
    current.push(line);
  }
  blocks.push(current.join('\n').trim());

  const tables: Schema['tables'] = new Map();
  let actionCheck: Schema['actionCheck'];
  for (const block of blocks) {
    const label = /^-- Upgrading from /.test(block) ? block : 'sql/schema.sql';
    for (const m of block.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g)) {
      const columns = new Map<string, string>();
      for (const line of m[2]!.split('\n')) {
        const c = line.match(/^\s+([a-z_]+)\s+(?!KEY)[a-z]/);
        if (c && !/^\s+(CONSTRAINT|PRIMARY|UNIQUE|CHECK)\b/i.test(line)) columns.set(c[1]!, label);
      }
      tables.set(m[1]!, { block: label, columns });
    }
    for (const m of block.matchAll(/ALTER TABLE (\w+) ADD COLUMN IF NOT EXISTS (\w+)/g)) {
      tables.get(m[1]!)?.columns.set(m[2]!, label);
    }
    for (const m of block.matchAll(/shipcue_report_events_action_check\s+CHECK \(action IN \(([^)]*)\)\)/g)) {
      actionCheck = { values: [...m[1]!.matchAll(/'(\w+)'/g)].map((v) => v[1]!), block: label };
    }
  }
  return { tables, actionCheck };
}

export interface DbState {
  columns: { table: string; column: string }[];
  rls: { table: string; on: boolean }[];
  /** pg_get_constraintdef of shipcue_report_events_action_check, or null when there is none. */
  actionCheck: string | null;
}

const blocksFix = (blocks: string[]) =>
  `run on your database (or run all of sql/schema.sql again; every line is safe to repeat):\n\n${blocks.join('\n\n')}`;

export function checkDatabase(schema: Schema, db: DbState): CheckResult[] {
  const out: CheckResult[] = [];
  const present = new Set(db.columns.map((c) => c.table));
  for (const [table, t] of schema.tables) {
    if (!present.has(table)) {
      out.push({ status: 'fail', title: table, detail: 'missing table', fix: `run sql/schema.sql on your database (from node_modules/shipcue/sql/schema.sql)` });
      continue;
    }
    const have = new Set(db.columns.filter((c) => c.table === table).map((c) => c.column));
    const missing = [...t.columns.keys()].filter((c) => !have.has(c));
    if (!missing.length) {
      out.push({ status: 'ok', title: table, detail: 'all columns' });
      continue;
    }
    const blocks = [...new Set(missing.map((c) => t.columns.get(c)!))];
    out.push({ status: 'fail', title: table, detail: `missing ${missing.join(', ')}`, fix: blocksFix(blocks) });
  }
  for (const table of schema.tables.keys()) {
    if (!present.has(table)) continue;
    const on = db.rls.find((r) => r.table === table)?.on ?? false;
    out.push(
      on
        ? { status: 'ok', title: `RLS on ${table}`, detail: 'on' }
        : {
            status: 'fail',
            title: `RLS on ${table}`,
            detail: 'off',
            fix: `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;\n(keeps browser keys such as Supabase's anon key out; the handler connects as the table's owner and is not affected. If your app connects as another role, add a policy for it.)`,
          },
    );
  }
  if (schema.actionCheck && present.has('shipcue_report_events')) {
    const def = db.actionCheck ?? '';
    const missing = schema.actionCheck.values.filter((v) => !def.includes(`'${v}'`));
    out.push(
      missing.length
        ? { status: 'fail', title: 'History actions', detail: `missing ${missing.join(', ')}`, fix: blocksFix([schema.actionCheck.block]) }
        : { status: 'ok', title: 'History actions', detail: 'current' },
    );
  }
  return out;
}
