import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, it, expect, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
// @ts-expect-error -- plain JS module for the site's function
import { createCloudHandler, insforgeAuth } from '../website/_src/cloud.mjs';

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
    // Google sign-in: the provider's page carries the challenge; the code "code:<email>" signs that person in.
    oauthCalls: [] as { provider: string; redirectUri: string; challenge: string }[],
    async oauthUrl(provider: string, redirectUri: string, challenge: string) {
      this.oauthCalls.push({ provider, redirectUri, challenge });
      return `https://accounts.google.com/o/oauth2/v2/auth?state=${challenge}`;
    },
    async exchange(code: string, verifier: string) {
      const email = code.slice(5);
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (!this.oauthCalls.some((c) => c.challenge === challenge)) throw Object.assign(new Error('Invalid code verifier'), { status: 400 });
      if (!users.has(email)) users.set(email, { id: crypto.randomUUID(), email, password: '' });
      return tokens(email);
    },
  };
}

let handle: (req: Request) => Promise<Response>;
let db: PGlite;
let auth: ReturnType<typeof fakeAuth>;

beforeEach(async () => {
  db = new PGlite();
  await db.exec(schema);
  await db.exec(cloud);
  auth = fakeAuth();
  handle = createCloudHandler({ db: { query: (t: string, p?: unknown[]) => db.query(t, p) }, auth, beta: ['ada@example.com'], secureCookies: false });
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

describe('shipcue Cloud: Continue with Google', () => {
  const cookieOf = (res: Response, name: string) => res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));

  it('starts on the provider page with a PKCE challenge and keeps the verifier in a short-lived httpOnly cookie', async () => {
    const res = await handle(new Request(`${BASE}/auth/oauth/google`));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/^https:\/\/accounts\.google\.com\//);
    const pkce = cookieOf(res, 'sc_pkce')!;
    expect(pkce).toContain('HttpOnly');
    expect(pkce).toMatch(/Max-Age=600/);
    const verifier = decodeURIComponent(pkce.split(';')[0]!.slice('sc_pkce='.length));
    const [call] = auth.oauthCalls;
    expect(call).toMatchObject({ provider: 'google', redirectUri: `${BASE}/auth/oauth/callback` });
    expect(call!.challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
    expect(verifier.length).toBeGreaterThanOrEqual(43);
  });

  it('takes GitHub too, and nothing else', async () => {
    expect((await handle(new Request(`${BASE}/auth/oauth/github`))).status).toBe(302);
    expect((await handle(new Request(`${BASE}/auth/oauth/myspace`))).status).toBe(404);
  });

  it('comes back, swaps the code for a session and lands on /app/ in the same account', async () => {
    await signUp('ada@example.com');
    const { data: before } = await call('GET', '/me', { as: 'ada@example.com' });
    const start = await handle(new Request(`${BASE}/auth/oauth/google`));
    const pkce = cookieOf(start, 'sc_pkce')!.split(';')[0]!;
    const back = await handle(new Request(`${BASE}/auth/oauth/callback?insforge_code=code:ada@example.com`, { headers: { cookie: pkce } }));
    expect(back.status).toBe(302);
    expect(back.headers.get('location')).toBe('https://shipcue.example.com/app/');
    expect(cookieOf(back, 'sc_pkce')).toMatch(/Max-Age=0/);
    const session = back.headers
      .getSetCookie()
      .filter((c) => c.startsWith('sc_at=') || c.startsWith('sc_rt='))
      .map((c) => c.split(';')[0])
      .join('; ');
    const me = await handle(new Request(`${BASE}/me`, { headers: { cookie: session } }));
    expect((await me.json()).user).toEqual(before.user);
  });

  it('sends people back to /app/ with a reason when it cannot finish', async () => {
    const noCookie = await handle(new Request(`${BASE}/auth/oauth/callback?insforge_code=code:ada@example.com`));
    expect(noCookie.status).toBe(302);
    expect(new URL(noCookie.headers.get('location')!).searchParams.get('error')).toMatch(/try again/i);
    const denied = await handle(new Request(`${BASE}/auth/oauth/callback?error=access_denied`, { headers: { cookie: 'sc_pkce=x'.padEnd(60, 'x') } }));
    expect(new URL(denied.headers.get('location')!).pathname).toBe('/app/');
    expect(new URL(denied.headers.get('location')!).searchParams.get('error')).toBeTruthy();
    const wrong = await handle(new Request(`${BASE}/auth/oauth/callback?insforge_code=code:ada@example.com`, { headers: { cookie: `sc_pkce=${'y'.repeat(43)}` } }));
    expect(new URL(wrong.headers.get('location')!).searchParams.get('error')).toBe('Invalid code verifier');
    expect(wrong.headers.getSetCookie().some((c) => c.startsWith('sc_at='))).toBe(false);
  });
});

describe('insforgeAuth: OAuth over REST', () => {
  it('asks InsForge for the provider URL and swaps the code as a server client', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const body = url.includes('/oauth/exchange')
        ? { accessToken: 'at', refreshToken: 'rt', user: { id: 'u1', email: 'ada@example.com' } }
        : { authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' };
      return new Response(JSON.stringify(body), { status: 200 });
    };
    const a = insforgeAuth('https://auth.example.com', fetchImpl);
    expect(await a.oauthUrl('google', 'https://shipcue.example.com/api/cloud/auth/oauth/callback', 'chal')).toBe('https://accounts.google.com/o/oauth2/v2/auth?x=1');
    const start = new URL(calls[0]!.url);
    expect(start.pathname).toBe('/api/auth/oauth/google');
    expect(start.searchParams.get('redirect_uri')).toBe('https://shipcue.example.com/api/cloud/auth/oauth/callback');
    expect(start.searchParams.get('code_challenge')).toBe('chal');
    expect(await a.exchange('the-code', 'the-verifier')).toEqual({ accessToken: 'at', refreshToken: 'rt', user: { id: 'u1', email: 'ada@example.com' } });
    expect(calls[1]!.url).toBe('https://auth.example.com/api/auth/oauth/exchange?client_type=server');
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ code: 'the-code', code_verifier: 'the-verifier' });
  });

  it('refuses a provider URL that is not https', async () => {
    const a = insforgeAuth('https://auth.example.com', async () => new Response(JSON.stringify({ authUrl: 'javascript:alert(1)' })));
    await expect(a.oauthUrl('google', 'https://x', 'c')).rejects.toThrow();
  });
});

describe('shipcue Cloud: the sites a project lists', () => {
  it('takes reports only from the sites listed, not from any page that posts a form', async () => {
    await signUp('ada@example.com');
    const { data: made } = await call('POST', '/projects', { as: 'ada@example.com', body: { name: 'Sites' } });
    await call('POST', `/projects/${made.project.id}/settings`, { as: 'ada@example.com', body: { allowedOrigins: ['https://app.example.com'] } });
    const file = (origin?: string) => {
      const form = new FormData();
      form.set('type', 'bug');
      form.set('description', 'The save button does nothing at all');
      return handle(new Request(`${BASE}/p/${made.project.publicKey}/reports`, { method: 'POST', body: form, headers: origin ? { origin } : {} }));
    };
    expect((await file('https://app.example.com')).status).toBe(201);
    // A form post is a "simple" request: the browser sends it without asking first, so CORS alone does not stop it.
    const foreign = await file('https://elsewhere.example');
    expect(foreign.status).toBe(403);
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull();
    // No Origin header: not a browser (a script or a server), which the list cannot speak for.
    expect((await file()).status).toBe(201);
    const { data } = await call('GET', `/p/${made.project.publicKey}/team/reports`, { as: 'ada@example.com' });
    expect(data.reports).toHaveLength(2);
  });
});

describe('shipcue Cloud: who filed it', () => {
  it('keeps the person the site says is signed in, cleaned and capped', async () => {
    await signUp('ada@example.com');
    const { data: made } = await call('POST', '/projects', { as: 'ada@example.com', body: { name: 'Who' } });
    const file = (user?: string) => {
      const form = new FormData();
      form.set('type', 'bug');
      form.set('description', 'The save button does nothing at all');
      return handle(new Request(`${BASE}/p/${made.project.publicKey}/reports`, { method: 'POST', body: form, headers: user === undefined ? {} : { 'x-shipcue-user': user } }));
    };
    expect((await file('  grace@example.com  ')).status).toBe(201);
    expect((await file()).status).toBe(201);
    expect((await file('x'.repeat(500))).status).toBe(201);
    expect((await file('bad\tname')).status).toBe(201);
    const { data } = await call('GET', `/p/${made.project.publicKey}/team/reports`, { as: 'ada@example.com' });
    const reporters = data.reports.map((r: { reporter: string | null }) => r.reporter).sort();
    expect(reporters).toContain('grace@example.com');
    expect(reporters).toContain(null);
    expect(reporters.find((r: string | null) => r?.startsWith('xxx'))).toHaveLength(200);
    expect(reporters).toContain('badname');
  });
});

describe('shipcue Cloud: a new key, and deleting a project', () => {
  async function project() {
    await signUp('ada@example.com');
    const { data } = await call('POST', '/projects', { as: 'ada@example.com', body: { name: 'Keys' } });
    await call('POST', `/projects/${data.project.id}/invites`, { as: 'ada@example.com', body: { email: 'bob@example.com', role: 'member' } });
    await signUp('bob@example.com');
    await call('GET', '/me', { as: 'bob@example.com' });
    return data.project as { id: string; publicKey: string };
  }
  const board = (key: string) => handle(new Request(`${BASE}/p/${key}/capabilities`));

  it('gives the button a new key and retires the old one (owners only)', async () => {
    const p = await project();
    expect((await call('POST', `/projects/${p.id}/rotate-key`, { as: 'bob@example.com', body: {} })).res.status).toBe(403);
    const { res, data } = await call('POST', `/projects/${p.id}/rotate-key`, { as: 'ada@example.com', body: {} });
    expect(res.status).toBe(200);
    expect(data.project.publicKey).toMatch(/^pk_[0-9a-f]{24}$/);
    expect(data.project.publicKey).not.toBe(p.publicKey);
    expect((await board(p.publicKey)).status).toBe(404);
    expect((await board(data.project.publicKey)).status).toBe(200);
  });

  it('deletes a project for everyone (owners only), keeping the rows', async () => {
    const p = await project();
    expect((await call('POST', `/projects/${p.id}/delete`, { as: 'bob@example.com', body: {} })).res.status).toBe(403);
    expect((await call('POST', `/projects/${p.id}/delete`, { as: 'ada@example.com', body: {} })).res.status).toBe(200);
    expect((await call('GET', '/me', { as: 'ada@example.com' })).data.projects).toEqual([]);
    expect((await call('GET', '/me', { as: 'bob@example.com' })).data.projects).toEqual([]);
    expect((await call('GET', `/projects/${p.id}`, { as: 'ada@example.com' })).res.status).toBe(404);
    expect((await board(p.publicKey)).status).toBe(404);
    const rows = await db.query<{ is_deleted: boolean }>('SELECT is_deleted FROM cloud_projects');
    expect(rows.rows).toEqual([{ is_deleted: true }]);
  });
});
