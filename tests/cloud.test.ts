import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
// @ts-expect-error -- plain JS module for the site's function
import { createCloudHandler, digestDue, insforgeAuth, insforgeEmail } from '../website/_src/cloud.mjs';

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

describe('forwarding (Slack and a signed webhook)', () => {
  it('announces a project\'s reports where its owner asked, signed, and never another project\'s', async () => {
    const posts: { url: string; body: string; sig: string | null }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      posts.push({ url: String(url), body: String(init?.body), sig: new Headers(init?.headers).get('x-shipcue-signature') });
      return new Response('ok');
    }) as typeof fetch;
    try {
      await signUp('ada@example.com');
      const { data: made } = await call('POST', '/projects', { as: 'ada@example.com', body: { name: 'Acme' } });
      const { id, publicKey } = made.project;
      expect((await call('POST', `/projects/${id}/settings`, { as: 'ada@example.com', body: { slackWebhookUrl: 'https://evil.example.com/x' } })).res.status).toBe(400);
      const { data } = await call('POST', `/projects/${id}/settings`, {
        as: 'ada@example.com',
        body: { slackWebhookUrl: 'https://hooks.slack.com/services/T0/B0/xyz', webhookUrl: 'https://hooks.acme.dev/shipcue', notifyEvents: ['report.filed'] },
      });
      expect(data.project).toMatchObject({ slackConnected: true, webhookUrl: 'https://hooks.acme.dev/shipcue', notifyEvents: ['report.filed'] });
      expect(JSON.stringify(data.project)).not.toContain('hooks.slack.com');
      expect(data.webhookSecret).toMatch(/^whsec_/);

      const form = new FormData();
      for (const [k, v] of Object.entries({ type: 'bug', priority: 'high', area: 'other', description: 'Checkout button is grey' })) form.set(k, v);
      await handle(new Request(`${BASE}/p/${publicKey}/reports`, { method: 'POST', body: form }));
      expect(posts.map((p) => new URL(p.url).host).sort()).toEqual(['hooks.acme.dev', 'hooks.slack.com']);
      const hook = posts.find((p) => p.url.includes('acme.dev'))!;
      const { signBody } = await import('../src/server');
      expect(hook.sig).toBe(signBody(data.webhookSecret, hook.body));
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('shipcue Cloud: the hosted agent (shipcue report 3d2dded6)', () => {
  const GOOD = { summary: 'The save button does nothing.', area: 'other', priority: 'high', priorityReason: 'Nobody can save.', steps: ['Click Save'], missing: [], plan: ['Find the save handler', 'Fix it'] };
  let pending: Promise<unknown>[];
  let openaiCalls: number;
  async function hostedProject(opts: { available?: boolean } = {}) {
    pending = [];
    openaiCalls = 0;
    handle = createCloudHandler({
      db: { query: (t: string, p?: unknown[]) => db.query(t, p) },
      auth,
      beta: ['ada@example.com'],
      secureCookies: false,
      hosted:
        opts.available === false
          ? null
          : {
              apiKey: 'sk-test',
              model: 'gpt-test',
              timeoutMs: 1000,
              dailyLimit: 2,
              fetchImpl: async () => {
                openaiCalls++;
                return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(GOOD) } }] }));
              },
            },
      background: (work: Promise<unknown>) => pending.push(work),
    });
    await signUp('ada@example.com');
    const { data } = await call('POST', '/projects', { as: 'ada@example.com', body: { name: 'Hosted' } });
    await call('POST', `/projects/${data.project.id}/invites`, { as: 'ada@example.com', body: { email: 'bob@example.com', role: 'member' } });
    await signUp('bob@example.com');
    await call('GET', '/me', { as: 'bob@example.com' });
    return data.project as { id: string; publicKey: string };
  }
  const file = (key: string, description = 'The save button does nothing at all') => {
    const form = new FormData();
    form.set('type', 'bug');
    form.set('description', description);
    return handle(new Request(`${BASE}/p/${key}/reports`, { method: 'POST', body: form }));
  };
  const settle = async () => {
    while (pending.length) await Promise.all(pending.splice(0));
  };

  it('owners turn it on and off; it is not offered where the server has no key', async () => {
    const p = await hostedProject();
    expect((await call('POST', `/projects/${p.id}/settings`, { as: 'bob@example.com', body: { hostedAgent: true } })).res.status).toBe(403);
    const { data } = await call('POST', `/projects/${p.id}/settings`, { as: 'ada@example.com', body: { hostedAgent: true, hostedAutoTriage: true } });
    expect(data.project).toMatchObject({ hostedAgent: true, hostedAutoTriage: true });
    const { data: detail } = await call('GET', `/projects/${p.id}`, { as: 'ada@example.com' });
    expect(detail.hosted).toEqual({ available: true, name: 'shipcue-agent', dailyLimit: 2 });
    // It is not one of the agents people connect (no token, no Disconnect), but it can be assigned work.
    expect(detail.agents).toEqual([]);
    const { data: me } = await call('GET', `/p/${p.publicKey}/team/me`, { as: 'ada@example.com' });
    expect(me.claimants.filter((c: { kind: string }) => c.kind === 'agent').map((c: { name: string }) => c.name)).toEqual(['shipcue-agent']);
    const rows = await db.query<{ token_hash: string | null; hosted: boolean }>('SELECT token_hash, hosted FROM cloud_agents WHERE revoked_at IS NULL');
    expect(rows.rows).toEqual([{ token_hash: null, hosted: true }]);
    // Turning it on twice keeps one; nobody can take its name.
    await call('POST', `/projects/${p.id}/settings`, { as: 'ada@example.com', body: { hostedAgent: true } });
    expect((await db.query('SELECT 1 FROM cloud_agents WHERE hosted AND revoked_at IS NULL')).rows).toHaveLength(1);
    expect((await call('POST', `/projects/${p.id}/agents`, { as: 'bob@example.com', body: { name: 'shipcue-agent' } })).res.status).toBe(400);

    // Off: it leaves the claimant list, and what was queued for it goes back to the queue.
    await call('POST', `/projects/${p.id}/settings`, { as: 'ada@example.com', body: { hostedAutoTriage: false } });
    await file(p.publicKey);
    const { data: list } = await call('GET', `/p/${p.publicKey}/team/reports`, { as: 'ada@example.com' });
    const id = list.reports[0].id;
    const bot = me.claimants.find((c: { kind: string }) => c.kind === 'agent');
    // Still queued for it (say its triage is under way) when it is turned off.
    await db.query(`UPDATE shipcue_reports SET claimant_kind = 'agent', claimant_id = $1, claimed_by = 'shipcue-agent' WHERE id = $2`, [bot.id, id]);
    await call('POST', `/projects/${p.id}/settings`, { as: 'ada@example.com', body: { hostedAgent: false } });
    const { data: after } = await call('GET', `/p/${p.publicKey}/team/reports/${id}`, { as: 'ada@example.com' });
    expect(after.report).toMatchObject({ status: 'open', claimantId: null });
    expect(after.events.map((e: { action: string }) => e.action)).toEqual(['released']);
    expect((await call('GET', `/p/${p.publicKey}/team/me`, { as: 'ada@example.com' })).data.claimants.some((c: { kind: string }) => c.kind === 'agent')).toBe(false);
    expect((await call('POST', `/p/${p.publicKey}/team/reports/${id}/assign`, { as: 'ada@example.com', body: { to: { kind: 'agent', id: bot.id } } })).res.status).toBe(400);
    expect(openaiCalls).toBe(0);

    const p2 = await hostedProject({ available: false });
    expect((await call('POST', `/projects/${p2.id}/settings`, { as: 'ada@example.com', body: { hostedAgent: true } })).res.status).toBe(409);
    expect((await call('GET', `/projects/${p2.id}`, { as: 'ada@example.com' })).data.hosted.available).toBe(false);
  });

  it('assigned a report from the CueLog, it triages after the response, notes it and puts it back', async () => {
    const p = await hostedProject();
    await call('POST', `/projects/${p.id}/settings`, { as: 'ada@example.com', body: { hostedAgent: true } });
    expect((await file(p.publicKey)).status).toBe(201);
    await settle();
    expect(openaiCalls).toBe(0); // auto-triage is off
    const { data: list } = await call('GET', `/p/${p.publicKey}/team/reports`, { as: 'ada@example.com' });
    const id = list.reports[0].id;
    const { data: me } = await call('GET', `/p/${p.publicKey}/team/me`, { as: 'ada@example.com' });
    const bot = me.claimants.find((c: { kind: string }) => c.kind === 'agent');
    const assigned = await call('POST', `/p/${p.publicKey}/team/reports/${id}/assign`, { as: 'ada@example.com', body: { to: { kind: 'agent', id: bot.id } } });
    expect(assigned.res.status).toBe(200);
    expect(pending).toHaveLength(1);
    await settle();
    const { data: after } = await call('GET', `/p/${p.publicKey}/team/reports/${id}`, { as: 'ada@example.com' });
    expect(after.report).toMatchObject({ status: 'open', claimantId: null });
    expect(after.events.map((e: { action: string }) => e.action)).toEqual(['assigned', 'claimed', 'note', 'released']);
    const note = after.events.find((e: { action: string }) => e.action === 'note');
    expect(note.actor).toMatchObject({ kind: 'agent', name: 'shipcue-agent' });
    expect(note.detail.text).toContain('Suggested priority: high. Nobody can save.');
  });

  it('auto-triage notes every new report, up to the daily cap', async () => {
    const p = await hostedProject();
    await call('POST', `/projects/${p.id}/settings`, { as: 'ada@example.com', body: { hostedAgent: true, hostedAutoTriage: true } });
    for (let i = 0; i < 3; i++) {
      expect((await file(p.publicKey, `The save button does nothing, take ${i}`)).status).toBe(201);
      await settle();
    }
    expect(openaiCalls).toBe(2);
    const notes = await db.query<{ text: string }>(`SELECT detail->>'text' AS text FROM shipcue_report_events WHERE action = 'note' ORDER BY seq`);
    expect(notes.rows).toHaveLength(3);
    expect(notes.rows[2]!.text).toMatch(/today's limit of 2/);
    const reports = await db.query<{ status: string; claimant_id: string | null }>('SELECT status, claimant_id FROM shipcue_reports');
    expect(reports.rows.every((r) => r.status === 'open' && r.claimant_id === null)).toBe(true);
  });
});

describe('shipcue Cloud: the activity digest (shipcue report 5f4d339b)', () => {
  const H = 60 * 60 * 1000;
  let emails: { to: string; subject: string; html: string; text: string }[];
  let slackPosts: { url: string; body: string }[];
  let realFetch: typeof fetch;
  beforeEach(() => {
    emails = [];
    slackPosts = [];
    realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      slackPosts.push({ url: String(url), body: String(init?.body) });
      return new Response('ok');
    }) as typeof fetch;
    handle = createCloudHandler({
      db: { query: (t: string, p?: unknown[]) => db.query(t, p) },
      auth,
      beta: ['ada@example.com'],
      secureCookies: false,
      cronSecret: 'cron-secret',
      sendEmail: async (m: (typeof emails)[number]) => void emails.push(m),
    });
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  const cron = (secret = 'cron-secret') => handle(new Request(`${BASE}/digest`, { headers: { authorization: `Bearer ${secret}` } }));
  async function project(name = 'Acme') {
    await signUp('ada@example.com');
    const { data } = await call('POST', '/projects', { as: 'ada@example.com', body: { name } });
    return data.project as { id: string; publicKey: string };
  }
  const file = (key: string, description: string) => {
    const form = new FormData();
    for (const [k, v] of Object.entries({ type: 'bug', priority: 'high', area: 'other', description, diagnostics: '{"secret":"diag-xyz"}' })) form.set(k, v);
    return handle(new Request(`${BASE}/p/${key}/reports`, { method: 'POST', body: form, headers: { 'x-shipcue-user': 'reporter@example.com' } }));
  };

  it('is due once a period has (nearly) passed, from where the last one ended', () => {
    const now = new Date('2026-10-03T12:00:00Z');
    expect(digestDue({ digest_every: 'off' }, now)).toBeNull();
    expect(digestDue({ digest_every: 'hour', digest_sent_at: null }, now)).toEqual({ since: new Date('2026-10-03T11:00:00Z'), until: now });
    expect(digestDue({ digest_every: 'hour', digest_sent_at: new Date(now.getTime() - 30 * 60 * 1000) }, now)).toBeNull();
    // A cron a few minutes early still counts; the period starts where the last one ended.
    const last = new Date(now.getTime() - 57 * 60 * 1000);
    expect(digestDue({ digest_every: 'hour', digest_sent_at: last }, now)).toEqual({ since: last, until: now });
    // Vercel's daily cron wanders within its hour.
    expect(digestDue({ digest_every: 'day', digest_sent_at: new Date(now.getTime() - 23 * H) }, now)).not.toBeNull();
    expect(digestDue({ digest_every: 'day', digest_sent_at: new Date(now.getTime() - 20 * H) }, now)).toBeNull();
    // After a long gap, only the last period.
    expect(digestDue({ digest_every: 'day', digest_sent_at: new Date('2026-09-01T00:00:00Z') }, now)).toEqual({ since: new Date('2026-10-02T12:00:00Z'), until: now });
  });

  it('owners pick how often and where; email only where the server can send it', async () => {
    const p = await project();
    await call('POST', `/projects/${p.id}/invites`, { as: 'ada@example.com', body: { email: 'bob@example.com', role: 'member' } });
    await signUp('bob@example.com');
    await call('GET', '/me', { as: 'bob@example.com' });
    expect((await call('POST', `/projects/${p.id}/settings`, { as: 'bob@example.com', body: { digestEvery: 'day' } })).res.status).toBe(403);
    expect((await call('POST', `/projects/${p.id}/settings`, { as: 'ada@example.com', body: { digestEvery: 'weekly' } })).res.status).toBe(400);
    expect((await call('POST', `/projects/${p.id}/settings`, { as: 'ada@example.com', body: { digestTo: 'sms' } })).res.status).toBe(400);
    const { data } = await call('POST', `/projects/${p.id}/settings`, { as: 'ada@example.com', body: { digestEvery: 'day', digestTo: 'email' } });
    expect(data.project).toMatchObject({ digestEvery: 'day', digestTo: 'email', digestSentAt: null });
    const { data: detail } = await call('GET', `/projects/${p.id}`, { as: 'ada@example.com' });
    expect(detail.digest).toEqual({ available: true, email: true });

    handle = createCloudHandler({ db: { query: (t: string, q?: unknown[]) => db.query(t, q) }, auth, beta: ['ada@example.com'], secureCookies: false });
    expect((await call('POST', `/projects/${p.id}/settings`, { as: 'ada@example.com', body: { digestTo: 'email' } })).res.status).toBe(409);
    expect((await call('GET', `/projects/${p.id}`, { as: 'ada@example.com' })).data.digest).toEqual({ available: false, email: false });
    // No cron secret: no cron route.
    expect((await cron()).status).toBe(404);
  });

  it('the cron needs its secret', async () => {
    expect((await cron('wrong')).status).toBe(401);
    expect((await handle(new Request(`${BASE}/digest`))).status).toBe(401);
    expect((await cron()).status).toBe(200);
  });

  it('sends due digests to Slack or the owner, once per period, without reporters or diagnostics', async () => {
    const a = await project('Acme');
    const { data: b } = await call('POST', '/projects', { as: 'ada@example.com', body: { name: 'Beta' } });
    const off = (await call('POST', '/projects', { as: 'ada@example.com', body: { name: 'Quiet' } })).data.project;
    await call('POST', `/projects/${a.id}/settings`, { as: 'ada@example.com', body: { digestEvery: 'hour', slackWebhookUrl: 'https://hooks.slack.com/services/T0/B0/xyz', notifyEvents: [] } });
    await call('POST', `/projects/${b.project.id}/settings`, { as: 'ada@example.com', body: { digestEvery: 'day', digestTo: 'email' } });
    await file(a.publicKey, 'Checkout button is grey');
    await file(b.project.publicKey, 'Beta search is slow');
    await file(off.publicKey, 'Never digested');
    slackPosts.length = 0;

    const { sent, results } = await (await cron()).json();
    expect(sent).toBe(2);
    expect(results).toHaveLength(2);
    expect(slackPosts).toHaveLength(1);
    const slackText = JSON.parse(slackPosts[0]!.body).text as string;
    expect(slackText).toContain('*Acme digest*');
    expect(slackText).toContain('Checkout button is grey');
    expect(slackText).not.toContain('Beta search');
    expect(emails).toHaveLength(1);
    expect(emails[0]).toMatchObject({ to: 'ada@example.com', subject: 'Beta digest: 1 filed, 1 still open' });
    expect(emails[0]!.text).toContain('Beta search is slow');
    expect(emails[0]!.text).not.toContain('Checkout');
    const everything = slackText + JSON.stringify(emails);
    expect(everything).not.toContain('reporter@example.com');
    expect(everything).not.toContain('diag-xyz');
    expect(everything).not.toContain('Never digested');

    // Recorded: the next run sends nothing until a period has passed.
    const rows = (await db.query<{ digest_sent_at: Date | null }>(`SELECT digest_sent_at FROM cloud_projects WHERE id = $1`, [a.id])).rows;
    expect(rows[0]!.digest_sent_at).not.toBeNull();
    expect((await (await cron()).json()).sent).toBe(0);
    expect(slackPosts).toHaveLength(1);
    expect(emails).toHaveLength(1);
  });

  it('skips a quiet period and one with nowhere to go, and retries a failed send', async () => {
    const p = await project();
    await call('POST', `/projects/${p.id}/settings`, { as: 'ada@example.com', body: { digestEvery: 'hour' } });
    // Slack chosen but not connected.
    expect((await (await cron()).json()).results).toEqual([{ project: p.id, sent: false, reason: 'no destination' }]);
    await db.query(`UPDATE cloud_projects SET digest_sent_at = NULL, slack_webhook_url = 'https://hooks.slack.com/services/T0/B0/xyz' WHERE id = $1`, [p.id]);
    expect((await (await cron()).json()).results).toEqual([{ project: p.id, sent: false, reason: 'no activity' }]);

    await db.query(`UPDATE cloud_projects SET digest_sent_at = NULL WHERE id = $1`, [p.id]);
    await file(p.publicKey, 'Something broke');
    globalThis.fetch = (async () => new Response('nope', { status: 500 })) as typeof fetch;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await (await cron()).json()).results).toEqual([{ project: p.id, sent: false, reason: 'failed' }]);
    errors.mockRestore();
    // Given back, so the next run tries again.
    expect((await db.query<{ digest_sent_at: Date | null }>(`SELECT digest_sent_at FROM cloud_projects WHERE id = $1`, [p.id])).rows[0]!.digest_sent_at).toBeNull();
    globalThis.fetch = (async () => new Response('ok')) as typeof fetch;
    expect((await (await cron()).json()).sent).toBe(1);
  });

  it('insforgeEmail sends through InsForge, and is off without a key', async () => {
    expect(insforgeEmail('https://auth.example.com', undefined)).toBeNull();
    const calls: { url: string; init: RequestInit }[] = [];
    const send = insforgeEmail('https://auth.example.com', 'key', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('{}');
    });
    await send({ to: 'a@example.com', subject: 's', html: '<p>h</p>', text: 'h' });
    expect(calls[0]!.url).toBe('https://auth.example.com/api/email/send-raw');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ to: 'a@example.com', subject: 's', html: '<p>h</p>', from: 'shipcue' });
  });
});

describe('shipcue Cloud: the GitHub webhook (shipcue report 919f5ca2)', () => {
  it('owners turn it on with a secret shown once, and a PR moves only this project\'s reports', async () => {
    const { createHmac } = await import('node:crypto');
    await signUp('ada@example.com');
    const { data: a } = await call('POST', '/projects', { as: 'ada@example.com', body: { name: 'Acme' } });
    const { data: b } = await call('POST', '/projects', { as: 'ada@example.com', body: { name: 'Other' } });
    const fileIn = async (key: string) => {
      const form = new FormData();
      for (const [k, v] of Object.entries({ type: 'bug', priority: 'high', area: 'other', description: 'Checkout button is grey' })) form.set(k, v);
      return (await (await handle(new Request(`${BASE}/p/${key}/reports`, { method: 'POST', body: form }))).json()).id as string;
    };
    const mine = await fileIn(a.project.publicKey);
    const theirs = await fileIn(b.project.publicKey);
    const send = (key: string, secret: string, prBody: string) => {
      const body = JSON.stringify({ action: 'opened', sender: { login: 'ada' }, pull_request: { number: 7, html_url: 'https://github.com/acme/app/pull/7', title: 'Fix', body: prBody, head: { ref: 'fix' } } });
      return handle(
        new Request(`${BASE}/p/${key}/github`, {
          method: 'POST',
          body,
          headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` },
        }),
      );
    };

    // Off until an owner turns it on.
    expect((await send(a.project.publicKey, 'x', mine)).status).toBe(404);
    const { data } = await call('POST', `/projects/${a.project.id}/settings`, { as: 'ada@example.com', body: { githubWebhook: true } });
    expect(data.githubSecret).toMatch(/^ghsec_[0-9a-f]{48}$/);
    expect(data.project.githubConnected).toBe(true);
    const { data: again } = await call('GET', `/projects/${a.project.id}`, { as: 'ada@example.com' });
    expect(JSON.stringify(again)).not.toContain(data.githubSecret);

    expect((await send(a.project.publicKey, 'wrong', mine)).status).toBe(401);
    // Another project's report id, even in full, moves nothing here.
    const res = await send(a.project.publicKey, data.githubSecret, `Fixes ${theirs} and ${mine.slice(0, 8)}`);
    expect((await res.json()).moved).toEqual([{ id: mine, status: 'in_review' }]);
    const { data: list } = await call('GET', `/p/${b.project.publicKey}/team/reports`, { as: 'ada@example.com' });
    expect(list.reports[0]).toMatchObject({ id: theirs, status: 'open' });

    await call('POST', `/projects/${a.project.id}/settings`, { as: 'ada@example.com', body: { githubWebhook: false } });
    expect((await send(a.project.publicKey, data.githubSecret, mine)).status).toBe(404);
  });
});
