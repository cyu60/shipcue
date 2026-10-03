import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
// @ts-expect-error -- plain JS module for the site's function
import { createCloudHandler } from '../website/_src/cloud.mjs';

const schema = readFileSync(new URL('../sql/schema.sql', import.meta.url), 'utf8');
const cloud = readFileSync(new URL('../sql/cloud.sql', import.meta.url), 'utf8');
const BASE = 'https://shipcue.example.com/api/cloud';

/** A stand-in for InsForge auth: users by email, access tokens "at:<email>", refresh "rt:<email>". */
function fakeAuth() {
  const users = new Map<string, { id: string; email: string; password: string }>();
  const tokens = (email: string) => ({ accessToken: `at:${email}`, refreshToken: `rt:${email}`, user: { id: users.get(email)!.id, email } });
  return {
    async signUp(email: string, password: string) {
      users.set(email, { id: crypto.randomUUID(), email, password });
      return { tokens: tokens(email), needsVerification: false };
    },
    async verify(email: string) {
      return tokens(email);
    },
    async resend() {},
    async signIn(email: string, password: string) {
      if (users.get(email)?.password !== password) throw Object.assign(new Error('Invalid credentials'), { status: 401 });
      return tokens(email);
    },
    async current(token: string) {
      const email = token.startsWith('at:') ? token.slice(3) : '';
      if (email.startsWith('expired')) throw Object.assign(new Error('expired'), { status: 401 });
      const u = users.get(email);
      return u ? { id: u.id, email } : null;
    },
    async refresh(token: string) {
      const email = token.slice(3).replace(/^expired-/, '');
      return users.has(email) ? tokens(email) : null;
    },
  };
}

let handle: (req: Request) => Promise<Response>;
let db: PGlite;

beforeEach(async () => {
  db = new PGlite();
  await db.exec(schema);
  await db.exec(cloud);
  handle = createCloudHandler({ db: { query: (t: string, p?: unknown[]) => db.query(t, p) }, auth: fakeAuth(), beta: ['ada@example.com'], secureCookies: false });
});

const jar = new Map<string, string>();
async function call(method: string, path: string, opts: { as?: string; body?: unknown; headers?: Record<string, string>; raw?: BodyInit } = {}) {
  const headers: Record<string, string> = { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...opts.headers };
  if (opts.as && jar.has(opts.as)) headers.cookie = jar.get(opts.as)!;
  const res = await handle(new Request(BASE + path, { method, headers, body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined) }));
  return { res, data: await res.clone().json().catch(() => null) };
}
async function signUp(email: string) {
  const { res } = await call('POST', '/auth/sign-up', { body: { email, password: 'long-enough-pw' } });
  const set = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  jar.set(email, set);
}

describe('shipcue Cloud', () => {
  it('signs up, keeps the session in httpOnly cookies, and knows who you are', async () => {
    const { res } = await call('POST', '/auth/sign-up', { body: { email: 'ada@example.com', password: 'long-enough-pw' } });
    expect(res.headers.getSetCookie().join(';')).toContain('HttpOnly');
    await signUp('ada@example.com');
    const { data } = await call('GET', '/me', { as: 'ada@example.com' });
    expect(data).toMatchObject({ user: { email: 'ada@example.com' }, canCreate: true, projects: [] });
    expect((await call('GET', '/me')).res.status).toBe(401);
  });

  it('is invite-only: someone off the beta list cannot create a project', async () => {
    await signUp('eve@example.com');
    expect((await call('POST', '/projects', { as: 'eve@example.com', body: { name: 'Mine' } })).res.status).toBe(403);
  });

  it('refuses cookie writes that are not JSON (no cross-site forms)', async () => {
    await signUp('ada@example.com');
    const form = new FormData();
    form.set('name', 'x');
    expect((await call('POST', '/projects', { as: 'ada@example.com', raw: form })).res.status).toBe(415);
  });

  it('runs a whole project: invite, connect an agent, file from the button, and work the queue together', async () => {
    await signUp('ada@example.com');
    const { data: made } = await call('POST', '/projects', { as: 'ada@example.com', body: { name: 'Habitect' } });
    const { id, publicKey } = made.project;
    expect(publicKey).toMatch(/^pk_[0-9a-f]{24}$/);
    await call('POST', `/projects/${id}/settings`, { as: 'ada@example.com', body: { allowedOrigins: ['https://app.example.com'], leaseSeconds: 600 } });

    // Bob is invited, signs up, and lands in the project.
    expect((await call('POST', `/projects/${id}/invites`, { as: 'ada@example.com', body: { email: 'bob@example.com', role: 'member' } })).res.status).toBe(201);
    await signUp('bob@example.com');
    const { data: bobMe } = await call('GET', '/me', { as: 'bob@example.com' });
    expect(bobMe.projects).toEqual([expect.objectContaining({ id, role: 'member' })]);
    expect(bobMe.canCreate).toBe(false);

    // An agent gets a token, shown once.
    const { data: agent } = await call('POST', `/projects/${id}/agents`, { as: 'bob@example.com', body: { name: 'claude-code' } });
    expect(agent.token).toMatch(/^sca_/);
    const stored = await db.query<{ token_hash: string }>('SELECT token_hash FROM cloud_agents');
    expect(stored.rows[0]!.token_hash).not.toContain(agent.token);

    // The button files from the app's origin.
    const form = new FormData();
    form.set('type', 'bug');
    form.set('priority', 'high');
    form.set('area', 'other');
    form.set('description', 'Saving a page loses the last block');
    const filed = await handle(new Request(`${BASE}/p/${publicKey}/reports`, { method: 'POST', body: form, headers: { origin: 'https://app.example.com' } }));
    expect(filed.status).toBe(201);
    expect(filed.headers.get('access-control-allow-origin')).toBe('https://app.example.com');

    // Ada assigns it to the agent from the CueLog; the agent takes it with its own token.
    const { data: list } = await call('GET', `/p/${publicKey}/team/reports`, { as: 'ada@example.com' });
    const reportId = list.reports[0].id;
    const { data: me } = await call('GET', `/p/${publicKey}/team/me`, { as: 'ada@example.com' });
    const bot = me.claimants.find((c: { kind: string }) => c.kind === 'agent');
    expect(bot.name).toBe('claude-code');
    await call('POST', `/p/${publicKey}/team/reports/${reportId}/assign`, { as: 'ada@example.com', body: { to: { kind: 'agent', id: bot.id } } });
    const claimed = await handle(new Request(`${BASE}/p/${publicKey}/reports/next/claim`, { method: 'POST', headers: { authorization: `Bearer ${agent.token}` } }));
    const { report } = await claimed.json();
    expect(report).toMatchObject({ id: reportId, claimedBy: 'claude-code', claimantKind: 'agent' });
    expect(Date.parse(report.leaseExpiresAt) - Date.now()).toBeLessThanOrEqual(600_000);

    // Another project never sees it.
    const { data: other } = await call('POST', '/projects', { as: 'ada@example.com', body: { name: 'Other' } });
    const { data: otherList } = await call('GET', `/p/${other.project.publicKey}/team/reports`, { as: 'ada@example.com' });
    expect(otherList.reports).toEqual([]);
    // And the agent's token does not work there.
    const wrong = await handle(new Request(`${BASE}/p/${other.project.publicKey}/reports`, { headers: { authorization: `Bearer ${agent.token}` } }));
    expect(wrong.status).toBe(401);

    // Someone not on the team cannot read the queue.
    await signUp('eve@example.com');
    expect((await call('GET', `/p/${publicKey}/team/reports`, { as: 'eve@example.com' })).res.status).toBe(401);
    expect((await call('GET', `/projects/${id}`, { as: 'eve@example.com' })).res.status).toBe(404);

    // Revoking the agent shuts its token off.
    await call('POST', `/projects/${id}/agents/${bot.id}/revoke`, { as: 'ada@example.com', body: {} });
    const after = await handle(new Request(`${BASE}/p/${publicKey}/reports`, { headers: { authorization: `Bearer ${agent.token}` } }));
    expect(after.status).toBe(401);
  });

  it('refreshes an expired session and keeps the last owner', async () => {
    await signUp('ada@example.com');
    const { data: made } = await call('POST', '/projects', { as: 'ada@example.com', body: { name: 'P' } });
    jar.set('ada-expired', 'sc_at=at:expired-ada@example.com; sc_rt=rt:ada@example.com');
    const { res, data } = await call('GET', `/projects/${made.project.id}`, { as: 'ada-expired' });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().join(';')).toContain('sc_at=at%3Aada%40example.com');
    const ownerId = data.members[0].id;
    expect((await call('POST', `/projects/${made.project.id}/members/${ownerId}/remove`, { as: 'ada@example.com', body: {} })).res.status).toBe(409);
  });
});
