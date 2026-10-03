// The reporter portal (shipcue report 3d0d7995): GET {base}/mine lists the signed-in reporter's
// own reports, only when the app vouches getReporter is session-backed (reporterPortal).
import { describe, it, expect } from 'vitest';
import { createShipcueHandler, emailReporter, memoryStore, type EmailMessage } from '../src/server';
import { resolveConfig, type Report } from '../src/core';

const BASE = 'https://app.example.com/api/shipcue';
const config = resolveConfig({ areas: [{ value: 'editor', label: 'Editor' }] });

// A fake session: the cookie names the signed-in user, as a real auth check would.
const sessionUser = async (req: Request) => /(?:^|;\s*)session=([^;]+)/.exec(req.headers.get('cookie') ?? '')?.[1] ?? null;
const get = (path: string, user?: string) => new Request(BASE + path, { headers: user ? { cookie: `session=${user}` } : {} });

async function seed(reporterPortal = true) {
  const store = memoryStore();
  const handle = createShipcueHandler({ store, config, basePath: '/api/shipcue', getReporter: sessionUser, agentToken: 'secret', reporterPortal });
  const base = { priority: 'medium' as const, area: 'editor', pageUrl: 'https://app.example.com/x', userAgent: 'UA', screenshots: [] as string[], context: null };
  const ada1 = await store.create({ ...base, type: 'bug', description: 'Save does nothing\nmore detail here', reporter: 'ada@example.com', diagnostics: { secret: 'token-123' } });
  const ada2 = await store.create({ ...base, type: 'feature', description: 'Dark mode please', reporter: 'ada@example.com', diagnostics: {} });
  const bob = await store.create({ ...base, type: 'bug', description: 'Bob sees a blank page', reporter: 'bob@example.com', diagnostics: {} });
  const anon = await store.create({ ...base, type: 'bug', description: 'Anonymous one', reporter: null, diagnostics: {} });
  await store.close(ada1.id, 'fixed', 'Save works again', { prUrl: 'https://github.com/o/r/pull/7' });
  return { store, handle, ada1, ada2, bob, anon };
}

describe('GET {base}/mine (report 3d0d7995)', () => {
  it("returns only the signed-in reporter's own reports, newest first, with status and fix line", async () => {
    const { handle, ada1, ada2 } = await seed();
    const res = await handle(get('/mine', 'ada@example.com'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    const { reports } = (await res.json()) as { reports: Record<string, unknown>[] };
    expect(reports.map((r) => r.id)).toEqual([ada2.id, ada1.id]);
    expect(reports[1]).toMatchObject({ type: 'bug', status: 'fixed', title: 'Save does nothing', resolution: 'Save works again', prUrl: 'https://github.com/o/r/pull/7' });
    expect(reports[0]).toMatchObject({ type: 'feature', status: 'open', resolution: null, prUrl: null });
  });

  it('never carries diagnostics, the page, attachments, the reporter or who holds it', async () => {
    const { handle } = await seed();
    const text = await (await handle(get('/mine', 'ada@example.com'))).text();
    expect(text).not.toContain('token-123');
    expect(text).not.toContain('app.example.com/x');
    const { reports } = JSON.parse(text) as { reports: Record<string, unknown>[] };
    for (const r of reports) {
      expect(Object.keys(r).sort()).toEqual(['createdAt', 'id', 'prUrl', 'resolution', 'status', 'title', 'type', 'updatedAt']);
    }
  });

  it("someone else sees only theirs, never Ada's or anonymous ones", async () => {
    const { handle, bob } = await seed();
    const { reports } = (await (await handle(get('/mine', 'bob@example.com'))).json()) as { reports: { id: string }[] };
    expect(reports.map((r) => r.id)).toEqual([bob.id]);
  });

  it('refuses signed-out people', async () => {
    const { handle } = await seed();
    const res = await handle(get('/mine'));
    expect(res.status).toBe(401);
  });

  it('is off without reporterPortal, even signed in', async () => {
    const { handle } = await seed(false);
    expect((await handle(get('/mine', 'ada@example.com'))).status).toBe(404);
  });

  it('is off without getReporter', async () => {
    const handle = createShipcueHandler({ store: memoryStore(), config, basePath: '/api/shipcue', reporterPortal: true });
    expect((await handle(get('/mine'))).status).toBe(404);
  });

  it('still shows only theirs when a custom store ignores the reporter filter', async () => {
    const { store, ada1, ada2 } = await seed();
    const careless = { ...store, list: (f?: Parameters<typeof store.list>[0]) => store.list({ ...f, reporter: undefined }) };
    const handle = createShipcueHandler({ store: careless, config, basePath: '/api/shipcue', getReporter: sessionUser, reporterPortal: true });
    const { reports } = (await (await handle(get('/mine', 'ada@example.com'))).json()) as { reports: { id: string }[] };
    expect(reports.map((r) => r.id).sort()).toEqual([ada1.id, ada2.id].sort());
  });

  it('capabilities says mine: true only with reporterPortal and a signed-in reporter', async () => {
    const on = (await seed()).handle;
    expect(((await (await on(get('/capabilities', 'ada@example.com'))).json()) as { mine?: boolean }).mine).toBe(true);
    expect(((await (await on(get('/capabilities'))).json()) as { mine?: boolean }).mine).toBeUndefined();
    const off = (await seed(false)).handle;
    expect(((await (await off(get('/capabilities', 'ada@example.com'))).json()) as { mine?: boolean }).mine).toBeUndefined();
  });
});

describe('the it-is-fixed email links the reporter portal', () => {
  it('adds "See all your reports" when mineLink is given', async () => {
    const sent: EmailMessage[] = [];
    const b = emailReporter({ appName: 'Acme', send: async (m) => void sent.push(m), mineLink: 'https://acme.dev/app/mine/' });
    const report = { id: 'r1', type: 'bug', status: 'fixed', description: 'Save broke', reporter: 'ada@example.com', resolution: 'Fixed save' } as Report;
    await b.send({ type: 'report.closed', at: new Date().toISOString(), report });
    expect(sent[0]!.text).toContain('See all your reports: https://acme.dev/app/mine/');
    expect(sent[0]!.html).toContain('href="https://acme.dev/app/mine/"');
  });
});

describe('shipcue Cloud projects have no reporter portal (their reporter is unverified)', () => {
  it('GET /p/<key>/mine is 404 even with an x-shipcue-user header, and capabilities never says mine', async () => {
    const { readFileSync } = await import('node:fs');
    const { PGlite } = await import('@electric-sql/pglite');
    // @ts-expect-error -- plain JS module for the site's function
    const { createCloudHandler } = await import('../website/_src/cloud.mjs');
    const db = new PGlite();
    await db.exec(readFileSync(new URL('../sql/schema.sql', import.meta.url), 'utf8'));
    await db.exec(readFileSync(new URL('../sql/cloud.sql', import.meta.url), 'utf8'));
    const users = new Map<string, string>();
    const auth = {
      async signUp(email: string) {
        users.set(email, crypto.randomUUID());
        return { tokens: { accessToken: `at:${email}`, refreshToken: `rt:${email}`, user: { id: users.get(email)!, email } }, needsVerification: false };
      },
      async current(token: string) {
        const email = token.slice(3);
        return users.has(email) ? { id: users.get(email)!, email } : null;
      },
      async refresh() {
        return null;
      },
    };
    const CLOUD = 'https://shipcue.example.com/api/cloud';
    const handle = createCloudHandler({ db: { query: (t: string, p?: unknown[]) => db.query(t, p) }, auth, beta: ['ada@example.com'], secureCookies: false });
    const signUp = await handle(new Request(`${CLOUD}/auth/sign-up`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'ada@example.com', password: 'long-enough-pw' }) }));
    const cookie = signUp.headers.getSetCookie().map((c: string) => c.split(';')[0]).join('; ');
    const created = await handle(new Request(`${CLOUD}/projects`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: 'P' }) }));
    const { publicKey } = ((await created.json()) as { project: { publicKey: string } }).project;
    const as = { 'x-shipcue-user': 'ada@example.com', cookie };
    expect((await handle(new Request(`${CLOUD}/p/${publicKey}/mine`, { headers: as }))).status).toBe(404);
    const caps = (await (await handle(new Request(`${CLOUD}/p/${publicKey}/capabilities`, { headers: as }))).json()) as { mine?: boolean };
    expect(caps.mine).toBeUndefined();
  }, 60_000);
});
