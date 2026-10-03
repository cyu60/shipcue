// shipcue doctor and init (shipcue report 5fdbd60f): pure checks on fixtures, then the CLI's
// output with everything outside (files, fetch, the database, vercel) faked. No network.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  checkInstalled,
  checkLockfiles,
  checkRoute,
  checkEnv,
  checkCapabilities,
  checkAgentApi,
  checkDatabase,
  compareVersions,
  envKeys,
  exitCode,
  findSignedUrls,
  formatResults,
  handlerEnvVars,
  parseSchema,
  parseVercelEnvLs,
  swapSignedUrls,
  stableReleaseUrl,
} from '../src/cli/checks';
import { runDoctor } from '../src/cli/doctor';
import { cloudInit, runInit } from '../src/cli/init';

const SCHEMA = readFileSync(join(__dirname, '../sql/schema.sql'), 'utf8');
const SIGNED =
  'https://release-assets.githubusercontent.com/github-production-release-asset/1/abc?sp=r&sv=2018-11-09&sr=b&spr=https&se=2026-10-02T21%3A27%3A35Z&rscd=attachment%3B+filename%3Dshipcue-0.17.0.tgz&sig=xyz';
const LOCK = `importers:
  .:
    dependencies:
      shipcue:
        specifier: https://github.com/cyu60/shipcue/releases/download/v0.17.0/shipcue-0.17.0.tgz
        version: ${SIGNED}(react-dom@19.0.0(react@19.0.0))(react@19.0.0)
packages:
  shipcue@${SIGNED}:
    resolution: {tarball: ${SIGNED}}
`;

describe('versions and install', () => {
  it('compares versions', () => {
    expect(compareVersions('0.24.2', '0.24.10')).toBeLessThan(0);
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.25.0', '0.24.9')).toBeGreaterThan(0);
  });

  it('fails when shipcue is not installed, with the install line', () => {
    const [r] = checkInstalled({});
    expect(r!.status).toBe('fail');
    expect(r!.fix).toContain('npm i shipcue');
    expect(r!.fix).toContain('releases/download');
  });

  it('passes with the version, and warns when a newer release is out', () => {
    expect(checkInstalled({ installed: '0.24.2', latest: '0.24.2' }).map((r) => r.status)).toEqual(['ok']);
    const rs = checkInstalled({ installed: '0.22.0', latest: 'v0.24.2' });
    expect(rs.map((r) => r.status)).toEqual(['ok', 'warn']);
    expect(rs[1]!.fix).toContain('0.24.2');
  });

  it('says when the newest release could not be looked up (offline) without failing', () => {
    const rs = checkInstalled({ installed: '0.24.2', latest: null });
    expect(rs.map((r) => r.status)).toEqual(['ok', 'skip']);
  });

  it('warns when package.json declares shipcue but node_modules has none', () => {
    const [r] = checkInstalled({ declared: '^0.24.0' });
    expect(r!.status).toBe('fail');
    expect(r!.fix).toMatch(/install/);
  });
});

describe('lockfile trap', () => {
  it('finds signed release-assets URLs without eating peer suffixes or key colons', () => {
    expect(findSignedUrls(LOCK)).toEqual([SIGNED, SIGNED, SIGNED]);
  });

  it('swaps only the URL for the stable release URL', () => {
    const stable = stableReleaseUrl('0.17.0');
    const out = swapSignedUrls(LOCK, stable);
    expect(out).not.toContain('release-assets');
    expect(out).toContain(`version: ${stable}(react-dom@19.0.0(react@19.0.0))(react@19.0.0)`);
    expect(out).toContain(`shipcue@${stable}:`);
    expect(out).toContain(`{tarball: ${stable}}`);
  });

  it('passes a clean lockfile and fails a signed one with the swap to run', () => {
    expect(checkLockfiles([{ name: 'pnpm-lock.yaml', text: 'lockfileVersion: 9.0\n' }], '0.17.0').status).toBe('ok');
    const r = checkLockfiles([{ name: 'pnpm-lock.yaml', text: LOCK }], '0.17.0');
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('pnpm-lock.yaml (3)');
    expect(r.fix).toContain(stableReleaseUrl('0.17.0'));
    expect(r.fix).toContain('--frozen-lockfile');
  });
});

describe('handler route', () => {
  it('finds the Next.js app router route, under src/ too', () => {
    const has = (set: string[]) => (p: string) => set.includes(p);
    expect(checkRoute(has(['app/api/shipcue/[...path]/route.ts'])).status).toBe('ok');
    expect(checkRoute(has(['src/app/api/shipcue/[...path]/route.js'])).detail).toContain('src/app');
    expect(checkRoute(has(['server/shipcue.ts']), 'server/shipcue.ts').status).toBe('ok');
  });

  it('fails with where to put it', () => {
    const r = checkRoute(() => false);
    expect(r.status).toBe('fail');
    expect(r.fix).toContain('app/api/shipcue/[...path]/route.ts');
    expect(r.fix).toContain('createShipcueHandler');
  });
});

describe('env vars', () => {
  it('reads keys with values from a .env file, never the values', () => {
    const keys = envKeys('# c\nDATABASE_URL="postgres://x"\nexport SHIPCUE_TOKEN=abc\nEMPTY=\nQUOTED=""\n');
    expect([...keys].sort()).toEqual(['DATABASE_URL', 'SHIPCUE_TOKEN']);
  });

  it('takes the env vars the route reads, or the defaults', () => {
    expect(handlerEnvVars('new Pool({ connectionString: process.env.DB_URL }); agentToken: process.env.SHIPCUE_TOKEN, x: process.env["OTHER"]')).toEqual(['DB_URL', 'SHIPCUE_TOKEN', 'OTHER']);
    expect(handlerEnvVars(undefined)).toEqual(['DATABASE_URL', 'SHIPCUE_TOKEN']);
    expect(handlerEnvVars('no env here')).toEqual(['DATABASE_URL', 'SHIPCUE_TOKEN']);
  });

  it('parses vercel env ls', () => {
    const out = `Vercel CLI 50.0.0
> Environment Variables found for team/app [200ms]

 name                value               environments                        created
 DATABASE_URL        Encrypted           Production, Preview, Development    3d ago
 SHIPCUE_TOKEN       Encrypted           Production                          1h ago
`;
    const m = parseVercelEnvLs(out);
    expect(m.get('DATABASE_URL')).toBe('Production, Preview, Development');
    expect(m.get('SHIPCUE_TOKEN')).toBe('Production');
    expect(m.has('name')).toBe(false);
  });

  it('passes vars found anywhere and fails the rest with the fix', () => {
    const rs = checkEnv(['DATABASE_URL', 'SHIPCUE_TOKEN'], [
      { label: '.env.local', keys: new Set(['DATABASE_URL']) },
      { label: 'Vercel', keys: new Map([['DATABASE_URL', 'Production']]) },
    ]);
    expect(rs[0]!.status).toBe('ok');
    expect(rs[0]!.detail).toBe('in .env.local, Vercel (Production)');
    expect(rs[1]!.status).toBe('fail');
    expect(rs[1]!.fix).toContain('openssl rand -hex 32');
    expect(rs[1]!.fix).toContain('vercel env add SHIPCUE_TOKEN production');
  });

  it('warns when a var is local but missing on a linked Vercel project', () => {
    const [r] = checkEnv(['DATABASE_URL'], [
      { label: '.env.local', keys: new Set(['DATABASE_URL']) },
      { label: 'Vercel', keys: new Map() },
    ]);
    expect(r!.status).toBe('fail');
    expect(r!.fix).toContain('vercel env add DATABASE_URL production');
  });
});

describe('live endpoint', () => {
  it('checks /capabilities', () => {
    expect(checkCapabilities(200, { maxScreenshots: 10 }).status).toBe('ok');
    expect(checkCapabilities(404, null).fix).toContain('route');
    expect(checkCapabilities(null, null).status).toBe('fail');
  });

  it('checks the agent API with the token', () => {
    expect(checkAgentApi(200).status).toBe('ok');
    expect(checkAgentApi(401).fix).toContain('SHIPCUE_TOKEN');
    expect(checkAgentApi(404).fix).toContain('agentToken');
    expect(checkAgentApi(undefined).status).toBe('skip');
  });
});

describe('schema', () => {
  const schema = parseSchema(SCHEMA);

  it('knows every table and column in sql/schema.sql and where each came from', () => {
    expect([...schema.tables.keys()]).toEqual(['shipcue_reports', 'shipcue_report_events']);
    const reports = schema.tables.get('shipcue_reports')!;
    expect(reports.columns.has('priority_rank')).toBe(true);
    expect(reports.columns.get('video')).toMatch(/^-- Upgrading from 0\.1:/);
    expect(reports.columns.get('client_key')).toMatch(/^-- Upgrading from 0\.13/);
    expect(schema.tables.get('shipcue_report_events')!.columns.get('seq')).toMatch(/^-- Upgrading from 0\.12/);
    expect(schema.actionCheck!.values).toContain('edited');
  });

  const all = () => {
    const columns: { table: string; column: string }[] = [];
    for (const [table, t] of schema.tables) for (const column of t.columns.keys()) columns.push({ table, column });
    return columns;
  };
  const def = `CHECK ((action = ANY (ARRAY['claimed'::text, 'assigned'::text, 'released'::text, 'expired'::text, 'review'::text, 'closed'::text, 'reopened'::text, 'priority'::text, 'note'::text, 'edited'::text])))`;
  const rlsOn = [{ table: 'shipcue_reports', on: true }, { table: 'shipcue_report_events', on: true }];

  it('passes an up-to-date database', () => {
    const rs = checkDatabase(schema, { columns: all(), rls: rlsOn, actionCheck: def });
    expect(rs.every((r) => r.status === 'ok')).toBe(true);
  });

  it('prints the upgrade block for missing columns, once per block', () => {
    const columns = all().filter((c) => !['claimant_kind', 'pr_url', 'client_key'].includes(c.column));
    const rs = checkDatabase(schema, { columns, rls: rlsOn, actionCheck: def });
    const r = rs.find((x) => x.status === 'fail')!;
    expect(r.title).toContain('shipcue_reports');
    expect(r.detail).toContain('claimant_kind, pr_url, client_key');
    expect(r.fix).toContain('-- Upgrading from 0.12');
    expect(r.fix).toContain('-- Upgrading from 0.13');
    expect(r.fix!.split('-- Upgrading from 0.12').length).toBe(2);
  });

  it('a missing table points at sql/schema.sql', () => {
    const rs = checkDatabase(schema, { columns: all().filter((c) => c.table !== 'shipcue_report_events'), rls: [rlsOn[0]!], actionCheck: null });
    const r = rs.find((x) => x.title.includes('shipcue_report_events'))!;
    expect(r.status).toBe('fail');
    expect(r.fix).toContain('sql/schema.sql');
  });

  it('fails RLS off with the line to run', () => {
    const rs = checkDatabase(schema, { columns: all(), rls: [{ table: 'shipcue_reports', on: false }, rlsOn[1]!], actionCheck: def });
    const r = rs.find((x) => x.title.startsWith('RLS'))!;
    expect(r.status).toBe('fail');
    expect(r.fix).toContain('ALTER TABLE shipcue_reports ENABLE ROW LEVEL SECURITY;');
  });

  it('fails an old history action check with the block that widens it', () => {
    const old = def.replace(", 'edited'::text", '');
    const r = checkDatabase(schema, { columns: all(), rls: rlsOn, actionCheck: old }).find((x) => x.status === 'fail')!;
    expect(r.detail).toContain('edited');
    expect(r.fix).toContain('-- Upgrading from 0.20/0.21');
  });
});

describe('output', () => {
  it('prints one line per check with the fix indented, and exits non-zero on any ✗', () => {
    const rs = [
      { status: 'ok' as const, title: 'shipcue installed', detail: '0.24.2' },
      { status: 'fail' as const, title: 'SHIPCUE_TOKEN', fix: 'add it\nthen redeploy' },
      { status: 'skip' as const, title: 'Live checks', detail: 'pass --url' },
    ];
    expect(formatResults(rs)).toBe(
      '✓ shipcue installed: 0.24.2\n✗ SHIPCUE_TOKEN\n    add it\n    then redeploy\n– Live checks: pass --url\n',
    );
    expect(exitCode(rs)).toBe(1);
    expect(exitCode([rs[0]!, rs[2]!])).toBe(0);
  });
});

function app(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'shipcue-doctor-'));
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  return dir;
}

describe('shipcue doctor (CLI)', () => {
  const route = `import { Pool } from 'pg';\nconst pool = new Pool({ connectionString: process.env.DATABASE_URL });\nexport const handler = createShipcueHandler({ agentToken: process.env.SHIPCUE_TOKEN });\n`;

  it('a healthy app, offline', async () => {
    const cwd = app({
      'package.json': JSON.stringify({ dependencies: { shipcue: '^0.24.2', next: '16' } }),
      'node_modules/shipcue/package.json': JSON.stringify({ name: 'shipcue', version: '0.24.2' }),
      'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
      'app/api/shipcue/[...path]/route.ts': route,
      '.env.local': 'DATABASE_URL=postgres://u:secretpw@h/db\nSHIPCUE_TOKEN=tok_secret\n',
    });
    const { output, code } = await runDoctor({ cwd, args: ['--offline'], schemaSql: SCHEMA, env: {} });
    expect(output).toBe(
      [
        '✓ shipcue installed: 0.24.2',
        '– Newest release: not checked (offline)',
        '✓ No signed release URLs in the lockfile',
        '✓ Handler route: app/api/shipcue/[...path]/route.ts',
        '✓ DATABASE_URL: in .env.local',
        '✓ SHIPCUE_TOKEN: in .env.local',
        '– Live checks: pass --url https://your-app/api/shipcue to check the endpoint, the token and the tables',
        '',
      ].join('\n'),
    );
    expect(output).not.toContain('secret');
    expect(code).toBe(0);
  });

  it('a broken app: trap, no route, no token, outdated; live checks against fakes', async () => {
    const cwd = app({
      'package.json': JSON.stringify({ dependencies: { shipcue: 'https://github.com/cyu60/shipcue/releases/download/v0.17.0/shipcue-0.17.0.tgz' } }),
      'node_modules/shipcue/package.json': JSON.stringify({ name: 'shipcue', version: '0.17.0' }),
      'pnpm-lock.yaml': LOCK,
      '.env': 'DATABASE_URL=postgres://x\n',
    });
    const schema = parseSchema(SCHEMA);
    const columns: { table: string; column: string }[] = [];
    for (const column of schema.tables.get('shipcue_reports')!.columns.keys()) if (column !== 'client_key') columns.push({ table: 'shipcue_reports', column });
    const calls: string[] = [];
    const { output, code } = await runDoctor({
      cwd,
      args: ['--url', 'https://app.example.com/api/shipcue/'],
      schemaSql: SCHEMA,
      env: {},
      fetch: async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${url} ${new Headers(init?.headers).has('authorization') ? 'auth' : ''}`.trim());
        if (url.includes('api.github.com')) return Response.json({ tag_name: 'v0.24.2' });
        if (url.endsWith('/capabilities')) return Response.json({ maxScreenshots: 10 });
        return new Response('nope', { status: 500 });
      },
      queryDb: async () => ({ columns, rls: [{ table: 'shipcue_reports', on: false }], actionCheck: null }),
    });
    expect(calls).toEqual(['GET https://api.github.com/repos/cyu60/shipcue/releases/latest', 'GET https://app.example.com/api/shipcue/capabilities']);
    const lines = output.split('\n').filter((l) => /^[✓✗!–] /.test(l));
    expect(lines).toEqual([
      '✓ shipcue installed: 0.17.0',
      '! Newest release: 0.24.2 is out',
      '✗ Signed release URLs in the lockfile: pnpm-lock.yaml (3)',
      '✗ Handler route: not found',
      '✓ DATABASE_URL: in .env',
      '✗ SHIPCUE_TOKEN: not set',
      '✓ GET /capabilities: 200',
      '– Agent API: no SHIPCUE_TOKEN to try',
      '✗ shipcue_reports: missing client_key',
      '✗ shipcue_report_events: missing table',
      '✗ RLS on shipcue_reports: off',
    ]);
    expect(output).toContain('-- Upgrading from 0.13');
    expect(code).toBe(1);
  });

  it('tries the agent API with the token from the env file, and reads vercel env when linked', async () => {
    const cwd = app({
      'package.json': JSON.stringify({ dependencies: { shipcue: '0.24.2' } }),
      'node_modules/shipcue/package.json': JSON.stringify({ name: 'shipcue', version: '0.24.2' }),
      'app/api/shipcue/[...path]/route.ts': route,
      '.vercel/project.json': '{}',
    });
    const seen: string[] = [];
    const { output } = await runDoctor({
      cwd,
      args: ['--url', 'https://app.example.com/api/shipcue', '--no-db', '--offline'],
      schemaSql: SCHEMA,
      env: { SHIPCUE_TOKEN: 'tok' },
      exec: async (cmd, args) => (seen.push([cmd, ...args].join(' ')), ' name  value  environments  created\n DATABASE_URL  Encrypted  Production  1d ago\n'),
      fetch: async (url: string, init?: RequestInit) => {
        if (url.endsWith('/capabilities')) return Response.json({});
        return new Response('{"reports":[]}', { status: new Headers(init?.headers).get('authorization') === 'Bearer tok' ? 200 : 401 });
      },
    });
    expect(seen).toEqual(['vercel env ls']);
    expect(output).toContain('✓ DATABASE_URL: in Vercel (Production)');
    expect(output).toContain('✗ SHIPCUE_TOKEN: in your shell, not on Vercel');
    expect(output).toContain('✓ Agent API: 200 with SHIPCUE_TOKEN');
    expect(output).toContain('– Tables: skipped (--no-db)');
  });
});

describe('shipcue init --cloud', () => {
  it('prints the env line and the button for a Cloud project', () => {
    const out = cloudInit({ key: 'pk_0123456789abcdef01234567' });
    expect(out.envLine).toBe('NEXT_PUBLIC_SHIPCUE_ENDPOINT=https://shipcue.ibuildathing.com/api/cloud/p/pk_0123456789abcdef01234567');
    expect(out.componentPath).toBe('components/shipcue-button.tsx');
    expect(out.component).toContain("'use client'");
    expect(out.component).toContain('endpoint={process.env.NEXT_PUBLIC_SHIPCUE_ENDPOINT}');
    expect(cloudInit({ key: 'pk_ab', origin: 'https://x.dev/', srcDir: true }).componentPath).toBe('src/components/shipcue-button.tsx');
  });

  it('refuses something that is not a public key', async () => {
    const r = await runInit({ cwd: app({}), args: ['--cloud', 'sca_secret_agent_token'] });
    expect(r.code).toBe(1);
    expect(r.output).toContain('pk_');
    expect(r.output).not.toContain('sca_secret');
  });

  it('--write adds the env line and the component, never overwriting', async () => {
    const cwd = app({ '.env.local': 'OTHER=1', 'src/app/layout.tsx': '' });
    const first = await runInit({ cwd, args: ['--cloud', 'pk_abc123', '--write'] });
    expect(first.code).toBe(0);
    expect(readFileSync(join(cwd, '.env.local'), 'utf8')).toBe('OTHER=1\nNEXT_PUBLIC_SHIPCUE_ENDPOINT=https://shipcue.ibuildathing.com/api/cloud/p/pk_abc123\n');
    expect(existsSync(join(cwd, 'src/components/shipcue-button.tsx'))).toBe(true);
    writeFileSync(join(cwd, 'src/components/shipcue-button.tsx'), 'mine');
    const second = await runInit({ cwd, args: ['--cloud', 'pk_abc123', '--write'] });
    expect(second.output).toContain('already');
    expect(readFileSync(join(cwd, 'src/components/shipcue-button.tsx'), 'utf8')).toBe('mine');
    expect(readFileSync(join(cwd, '.env.local'), 'utf8').match(/NEXT_PUBLIC_SHIPCUE_ENDPOINT/g)!.length).toBe(1);
  });
});
