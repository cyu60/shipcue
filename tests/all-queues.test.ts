// One view of every queue, with waiting time and versions (shipcue report e4e1a85e): the version in
// /capabilities, Cloud's All projects overview (scoped to the projects you are in), its waiting /
// stuck / nobody-has-looked math, the app-version fetch (timeout, failure, cache), and the CueLog's
// matching "Nobody has looked" filter.
import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { SHIPCUE_VERSION, compareVersions, parseVersion, type Report } from '../src/core';
import { createShipcueHandler, memoryStore } from '../src/server';
import { filterReports, nobodyLooked } from '../src/react/CueLog';
// @ts-expect-error -- plain JS module for the site's function
import { createCloudHandler } from '../website/_src/cloud.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
const schema = readFileSync(new URL('../sql/schema.sql', import.meta.url), 'utf8');
const cloudSql = readFileSync(new URL('../sql/cloud.sql', import.meta.url), 'utf8');
const BASE = 'https://shipcue.example.com/api/cloud';

describe('the installed version', () => {
  it('is package.json\'s version, set at build time', () => {
    expect(SHIPCUE_VERSION).toBe(pkg.version);
  });

  it('compares versions, and says null for anything that is not one', () => {
    expect(compareVersions('0.17.0', '0.25.0')).toBe(-1);
    expect(compareVersions('0.25.0', '0.25.0')).toBe(0);
    expect(compareVersions('1.0.0', '0.99.9')).toBe(1);
    expect(compareVersions('0.9.0', '0.10.0')).toBe(-1);
    expect(compareVersions('v0.24.2', '0.24.2')).toBe(0);
    expect(compareVersions('nope', '0.1.0')).toBeNull();
    expect(compareVersions(undefined, '0.1.0')).toBeNull();
    expect(parseVersion('0.24.2-beta.1')).toEqual([0, 24, 2]);
  });

  it('comes back from /capabilities', async () => {
    const handle = createShipcueHandler({ store: memoryStore(), basePath: '/api/shipcue' });
    const caps = await (await handle(new Request('https://app.example.com/api/shipcue/capabilities'))).json();
    expect(caps.version).toBe(pkg.version);
  });
});

/** A stand-in for InsForge auth: access tokens "at:<email>". */
function fakeAuth() {
  const users = new Map<string, string>();
  const tokens = (email: string) => ({ accessToken: `at:${email}`, refreshToken: `rt:${email}`, user: { id: users.get(email)!, email } });
  return {
    async signUp(email: string) {
      users.set(email, crypto.randomUUID());
      return { tokens: tokens(email), needsVerification: false };
    },
    async current(token: string) {
      const email = token.slice(3);
      return users.has(email) ? { id: users.get(email)!, email } : null;
    },
    async refresh() {
      return null;
    },
  };
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

describe('shipcue Cloud: All projects', () => {
  let db: PGlite;
  let fetches: string[];
  let appFetch: Fetch;
  let handle: (req: Request) => Promise<Response>;
  let auth: ReturnType<typeof fakeAuth>;
  const jar = new Map<string, string>();

  const make = (o: Record<string, unknown> = {}) =>
    createCloudHandler({
      db: { query: (t: string, p?: unknown[]) => db.query(t, p) },
      auth,
      beta: ['ada@example.com', 'bob@example.com'],
      secureCookies: false,
      latestVersion: '0.25.0',
      versionTimeoutMs: 50,
      fetch: (url: string, init?: RequestInit) => {
        fetches.push(url);
        return appFetch(url, init);
      },
      ...o,
    });

  async function call(method: string, path: string, as?: string, body?: unknown) {
    const headers: Record<string, string> = body !== undefined ? { 'content-type': 'application/json' } : {};
    if (as && jar.has(as)) headers.cookie = jar.get(as)!;
    const res = await handle(new Request(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined }));
    return { res, data: await res.clone().json().catch(() => null) };
  }
  async function signUp(email: string) {
    const { res } = await call('POST', '/auth/sign-up', undefined, { email, password: 'long-enough-pw' });
    jar.set(email, res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '));
  }
  async function project(as: string, name: string) {
    return (await call('POST', '/projects', as, { name })).data.project as { id: string; publicKey: string };
  }
  /** A report in a project, filed `ageMinutes` ago. */
  async function report(projectId: string, o: { status?: string; ageMinutes?: number; claimant?: string; leaseMinutes?: number; text?: string } = {}) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO shipcue_reports (type, priority, area, description, status, project_id, claimant_kind, claimant_id, claimed_by, lease_expires_at, created_at, updated_at)
       VALUES ('bug', 'medium', 'other', $1, $2, $3, $4, $5, $5, $6, now() - make_interval(mins => $7), now() - make_interval(mins => $7)) RETURNING id`,
      [
        o.text ?? 'Something broke',
        o.status ?? 'open',
        projectId,
        o.claimant ? 'agent' : null,
        o.claimant ?? null,
        o.leaseMinutes === undefined ? null : new Date(Date.now() + o.leaseMinutes * 60_000).toISOString(),
        o.ageMinutes ?? 0,
      ],
    );
    return rows[0]!.id;
  }
  const event = (reportId: string, projectId: string, action: string) =>
    db.query(`INSERT INTO shipcue_report_events (report_id, project_id, action, actor_kind, actor_id, actor_name) VALUES ($1, $2, $3, 'person', 'u', 'Ada')`, [
      reportId,
      projectId,
      action,
    ]);

  beforeEach(async () => {
    db = new PGlite();
    await db.exec(schema);
    await db.exec(cloudSql);
    fetches = [];
    auth = fakeAuth();
    appFetch = async () => new Response(JSON.stringify({ version: '0.17.0' }), { headers: { 'content-type': 'application/json' } });
    handle = make();
    jar.clear();
    await signUp('ada@example.com');
    await signUp('bob@example.com');
  });

  it('needs a session', async () => {
    expect((await call('GET', '/overview')).res.status).toBe(401);
    expect((await call('GET', '/overview/versions')).res.status).toBe(401);
  });

  it('shows only the projects you are in, never anyone else\'s', async () => {
    const a1 = await project('ada@example.com', 'Habitect');
    const a2 = await project('ada@example.com', 'ai-me');
    const b1 = await project('bob@example.com', 'Bob only');
    await report(b1.id);
    // Bob is invited to ai-me, so he sees it as well as his own.
    await call('POST', `/projects/${a2.id}/invites`, 'ada@example.com', { email: 'bob@example.com', role: 'viewer' });
    await call('GET', '/me', 'bob@example.com');

    const ada = (await call('GET', '/overview', 'ada@example.com')).data;
    expect(ada.projects.map((p: { name: string }) => p.name).sort()).toEqual(['Habitect', 'ai-me']);
    expect(JSON.stringify(ada)).not.toContain(b1.id);
    const bob = (await call('GET', '/overview', 'bob@example.com')).data;
    expect(bob.projects.map((p: { name: string; role: string }) => [p.name, p.role]).sort()).toEqual([
      ['Bob only', 'owner'],
      ['ai-me', 'viewer'],
    ]);
    expect(JSON.stringify(bob)).not.toContain(a1.id);

    // Removed from a project: gone from the overview. A deleted project too.
    const bobRow = (await db.query<{ id: string }>(`SELECT id FROM cloud_members WHERE project_id = $1 AND role = 'viewer'`, [a2.id])).rows[0]!;
    await call('POST', `/projects/${a2.id}/members/${bobRow.id}/remove`, 'ada@example.com', {});
    expect((await call('GET', '/overview', 'bob@example.com')).data.projects.map((p: { name: string }) => p.name)).toEqual(['Bob only']);
    await call('POST', `/projects/${a1.id}/delete`, 'ada@example.com', {});
    expect((await call('GET', '/overview', 'ada@example.com')).data.projects.map((p: { name: string }) => p.name)).toEqual(['ai-me']);
  });

  it('counts open, claimed, in review, oldest waiting, stuck claims and nobody-has-looked', async () => {
    const p = await project('ada@example.com', 'Habitect');
    const other = await project('ada@example.com', 'Quiet');
    const old = await report(p.id, { ageMinutes: 3 * 24 * 60, text: 'Oldest one\nwith more lines' }); // open, untouched: waiting 3d
    const noted = await report(p.id, { ageMinutes: 60 });
    await event(noted, p.id, 'note');
    const released = await report(p.id, { ageMinutes: 30 }); // claimed once, released: someone has looked
    await event(released, p.id, 'claimed');
    await event(released, p.id, 'released');
    await report(p.id, { ageMinutes: 10, claimant: 'claude-code' }); // queued for an agent (assigned): open, but looked at
    await report(p.id, { status: 'claimed', claimant: 'claude-code', leaseMinutes: -5, ageMinutes: 120 }); // stuck past its lease
    await report(p.id, { status: 'claimed', claimant: 'codex', leaseMinutes: 30 });
    await report(p.id, { status: 'in_review' });
    await report(p.id, { status: 'fixed', ageMinutes: 9999 });
    const gone = await report(p.id, { ageMinutes: 9000 });
    await db.query(`UPDATE shipcue_reports SET is_deleted = true WHERE id = $1`, [gone]);

    const { data } = await call('GET', '/overview', 'ada@example.com');
    expect(data.latest).toBe('0.25.0');
    const row = data.projects.find((x: { id: string }) => x.id === p.id);
    expect(row).toMatchObject({ name: 'Habitect', open: 4, claimed: 2, inReview: 1, stuck: 1, unlooked: 1 });
    expect(Date.now() - Date.parse(row.oldestOpenAt)).toBeGreaterThan(3 * 24 * 3600_000 - 60_000);
    expect(row.unlookedReports).toEqual([{ id: old, type: 'bug', headline: 'Oldest one', createdAt: expect.any(String) }]);
    expect(data.projects.find((x: { id: string }) => x.id === other.id)).toMatchObject({ open: 0, claimed: 0, inReview: 0, stuck: 0, unlooked: 0, oldestOpenAt: null, unlookedReports: [] });
  });

  it('keeps an app URL per project (owners only, https)', async () => {
    const p = await project('ada@example.com', 'Habitect');
    expect((await call('POST', `/projects/${p.id}/settings`, 'ada@example.com', { appUrl: 'http://app.example.com/api/shipcue' })).res.status).toBe(400);
    expect((await call('POST', `/projects/${p.id}/settings`, 'ada@example.com', { appUrl: 'https://user:pw@app.example.com/api/shipcue' })).res.status).toBe(400);
    const ok = await call('POST', `/projects/${p.id}/settings`, 'ada@example.com', { appUrl: 'https://app.example.com/api/shipcue/' });
    expect(ok.data.project.appUrl).toBe('https://app.example.com/api/shipcue');
    expect((await call('GET', '/overview', 'ada@example.com')).data.projects[0].appUrl).toBe('https://app.example.com/api/shipcue');
    expect((await call('POST', `/projects/${p.id}/settings`, 'ada@example.com', { appUrl: '' })).data.project.appUrl).toBeNull();
  });

  it('fetches each app\'s version from its /capabilities, and says when it is behind', async () => {
    const p = await project('ada@example.com', 'Habitect');
    const q = await project('ada@example.com', 'ai-me');
    await project('ada@example.com', 'No URL');
    await call('POST', `/projects/${p.id}/settings`, 'ada@example.com', { appUrl: 'https://app.example.com/api/shipcue' });
    await call('POST', `/projects/${q.id}/settings`, 'ada@example.com', { appUrl: 'https://other.example.com/api/shipcue' });
    appFetch = async (url) =>
      new Response(JSON.stringify({ version: url.startsWith('https://app.') ? '0.17.0' : '0.25.0' }), { headers: { 'content-type': 'application/json' } });
    const { data } = await call('GET', '/overview/versions', 'ada@example.com');
    expect(data.latest).toBe('0.25.0');
    expect(data.versions).toEqual({ [p.id]: { version: '0.17.0', behind: true }, [q.id]: { version: '0.25.0', behind: false } });
    expect(fetches.sort()).toEqual(['https://app.example.com/api/shipcue/capabilities', 'https://other.example.com/api/shipcue/capabilities']);
  });

  it('shows "unknown" when an app is slow, down, old or says something odd, and never waits past the timeout', async () => {
    const p = await project('ada@example.com', 'Habitect');
    await call('POST', `/projects/${p.id}/settings`, 'ada@example.com', { appUrl: 'https://app.example.com/api/shipcue' });
    const cases: Fetch[] = [
      // Hangs until aborted.
      (_url, init) => new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))),
      async () => {
        throw new Error('ECONNREFUSED');
      },
      async () => new Response('nope', { status: 500 }),
      async () => new Response('<html>', { headers: { 'content-type': 'text/html' } }),
      // A handler from before the version field has none.
      async () => new Response(JSON.stringify({ video: null }), { headers: { 'content-type': 'application/json' } }),
      async () => new Response(JSON.stringify({ version: '<script>' }), { headers: { 'content-type': 'application/json' } }),
    ];
    for (const f of cases) {
      appFetch = f;
      handle = make({ versionCacheMs: 0 });
      const started = Date.now();
      const { res, data } = await call('GET', '/overview/versions', 'ada@example.com');
      expect(res.status).toBe(200);
      expect(data.versions[p.id]).toEqual({ version: null, behind: null });
      expect(Date.now() - started).toBeLessThan(5000);
    }
  });

  it('caches each app\'s version briefly', async () => {
    const p = await project('ada@example.com', 'Habitect');
    await call('POST', `/projects/${p.id}/settings`, 'ada@example.com', { appUrl: 'https://app.example.com/api/shipcue' });
    await call('GET', '/overview/versions', 'ada@example.com');
    await call('GET', '/overview/versions', 'ada@example.com');
    expect(fetches).toHaveLength(1);
    handle = make({ versionCacheMs: 0 });
    await call('GET', '/overview/versions', 'ada@example.com');
    await call('GET', '/overview/versions', 'ada@example.com');
    expect(fetches).toHaveLength(3);
  });
});

describe('the CueLog: Nobody has looked', () => {
  const base: Report = {
    id: 'r1',
    type: 'bug',
    priority: 'medium',
    area: 'other',
    description: 'x',
    pageUrl: '',
    userAgent: '',
    diagnostics: {},
    screenshots: [],
    reporter: null,
    status: 'open',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    claimedBy: null,
    claimedAt: null,
    resolution: null,
    video: null,
    context: null,
  };
  it('keeps open reports nobody holds and nothing has happened to since filing (a video added while filing aside)', () => {
    const untouched = base;
    const withVideo = { ...base, id: 'r2', updatedAt: '2026-10-01T00:00:40.000Z' };
    const noted = { ...base, id: 'r3', updatedAt: '2026-10-01T05:00:00.000Z' };
    const queued = { ...base, id: 'r4', claimantKind: 'agent' as const, claimantId: 'a1', claimedBy: 'bot' };
    const claimed = { ...base, id: 'r5', status: 'claimed' as const, claimantKind: 'agent' as const, claimantId: 'a1', claimedBy: 'bot' };
    const fixed = { ...base, id: 'r6', status: 'fixed' as const };
    expect([untouched, withVideo, noted, queued, claimed, fixed].map(nobodyLooked)).toEqual([true, true, false, false, false, false]);
    expect(filterReports([untouched, withVideo, noted, queued, claimed, fixed], { tab: 'open', claimant: 'unlooked' }, null).map((r) => r.id)).toEqual(['r1', 'r2']);
  });
});
