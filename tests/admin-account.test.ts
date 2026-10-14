// Forgot password (a code by email) and invite emails in the admin.
import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createAdminHandler, insforgeAuth, inviteEmail, type AdminAuth } from '../src/admin';
import type { EmailMessage } from '../src/server';

const schema = readFileSync(new URL('../sql/schema.sql', import.meta.url), 'utf8');
const cloud = readFileSync(new URL('../sql/cloud.sql', import.meta.url), 'utf8');
const BASE = 'https://shipcue.example.com/api/cloud';

let db: PGlite;
let handle: (req: Request) => Promise<Response>;
let sent: EmailMessage[];
let resets: string[];
const passwords = new Map<string, string>();
const ids = new Map<string, string>();

const auth: AdminAuth = {
  current: async (t) => (t.startsWith('at:') && ids.has(t.slice(3)) ? { id: ids.get(t.slice(3))!, email: t.slice(3) } : null),
  refresh: async () => null,
  signIn: async (email, password) => (passwords.get(email) === password ? { accessToken: `at:${email}`, refreshToken: 'rt' } : null),
  sendReset: async (email) => {
    resets.push(email);
  },
  resetPassword: async (email, code, password) => {
    if (code !== '123456') throw Object.assign(new Error('Invalid code'), { status: 400 });
    passwords.set(email, password);
    return { accessToken: `at:${email}`, refreshToken: 'rt' };
  },
};

const post = (path: string, body: unknown, cookie?: string) =>
  handle(new Request(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) }));
const cookieOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

beforeEach(async () => {
  db = new PGlite();
  await db.exec(schema);
  await db.exec(cloud);
  sent = [];
  resets = [];
  passwords.clear();
  ids.clear();
  ids.set('ada@example.com', crypto.randomUUID());
  passwords.set('ada@example.com', 'old-password');
  handle = createAdminHandler({ db, auth, beta: ['ada@example.com'], sendEmail: async (m) => void sent.push(m) });
});

describe('forgot password', () => {
  it('sends a code, then a right code sets the password and signs in', async () => {
    const forgot = await post('/auth/forgot', { email: 'Ada@Example.com' });
    expect(await forgot.json()).toEqual({ ok: true });
    expect(resets).toEqual(['ada@example.com']);

    expect((await post('/auth/reset', { email: 'ada@example.com', code: '000000', password: 'new-password' })).status).toBe(400);
    expect((await post('/auth/reset', { email: 'ada@example.com', code: '123456', password: 'short' })).status).toBe(400);
    const res = await post('/auth/reset', { email: 'ada@example.com', code: '123456', password: 'new-password' });
    expect(res.status).toBe(200);
    expect(cookieOf(res)).toContain('sc_at=at%3Aada%40example.com');
    expect((await post('/auth/sign-in', { email: 'ada@example.com', password: 'new-password' })).status).toBe(200);
  });

  it('says "sent" whether or not the email has an account, and even when sending fails', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    auth.sendReset = async () => {
      throw new Error('no such user');
    };
    expect(await (await post('/auth/forgot', { email: 'nobody@example.com' })).json()).toEqual({ ok: true });
    quiet.mockRestore();
    auth.sendReset = async (email) => void resets.push(email);
  });

  it('is off without the adapter methods', async () => {
    const bare = createAdminHandler({ db, auth: { current: auth.current, refresh: auth.refresh } });
    expect((await bare(new Request(`${BASE}/auth/forgot`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"email":"a@b.co"}' }))).status).toBe(404);
  });
});

describe('invite emails', () => {
  it('emails the person invited, and the invite stands when the email fails', async () => {
    const cookie = cookieOf(await post('/auth/sign-in', { email: 'ada@example.com', password: 'old-password' }));
    const { project } = await (await post('/projects', { name: 'Acme <App>' }, cookie)).json();
    const res = await post(`/projects/${project.id}/invites`, { email: 'bob@example.com', role: 'viewer' }, cookie);
    expect(res.status).toBe(201);
    expect((await res.json()).emailed).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'bob@example.com', subject: 'ada invited you to Acme <App> on shipcue' });
    expect(sent[0]!.html).toContain('Acme &#60;App&#62;');
    expect(sent[0]!.text).toContain('https://shipcue.example.com/app/');
    expect(sent[0]!.text).toContain('see its queue');

    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = createAdminHandler({ db, auth, sendEmail: async () => Promise.reject(new Error('down')) });
    const again = await failing(
      new Request(`${BASE}/projects/${project.id}/invites`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ email: 'cy@example.com' }) }),
    );
    quiet.mockRestore();
    expect(again.status).toBe(201);
    expect((await again.json()).emailed).toBe(false);
  });

  it('writes the invite as text and html', () => {
    const m = inviteEmail({ to: 'b@x.co', from: 'Ada', project: 'P', role: 'member', link: 'https://h/app/' });
    expect(m.text).toBe('Ada invited you to P on shipcue, to work its queue with the team.\n\nSign up or sign in with b@x.co and you will land in the project:\nhttps://h/app/\n');
  });
});

describe('insforgeAuth reset', () => {
  it('trades the code for a token, sets the password with it, then signs in', async () => {
    const calls: { path: string; body: unknown }[] = [];
    const replies: Record<string, unknown> = {
      '/api/auth/email/send-reset-password': { success: true },
      '/api/auth/email/exchange-reset-password-token': { token: 'rst_1', expiresAt: 'later' },
      '/api/auth/email/reset-password': { message: 'ok' },
      '/api/auth/sessions?client_type=server': { accessToken: 'a', refreshToken: 'r', user: { id: 'u', email: 'ada@example.com' } },
    };
    const a = insforgeAuth('https://auth.example.com', async (url, init) => {
      const path = url.slice('https://auth.example.com'.length);
      calls.push({ path, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(replies[path] ?? {}));
    });
    await a.sendReset('ada@example.com');
    const t = await a.resetPassword('ada@example.com', '123456', 'new-password');
    expect(t).toMatchObject({ accessToken: 'a' });
    expect(calls).toEqual([
      { path: '/api/auth/email/send-reset-password', body: { email: 'ada@example.com' } },
      { path: '/api/auth/email/exchange-reset-password-token', body: { email: 'ada@example.com', code: '123456' } },
      { path: '/api/auth/email/reset-password', body: { newPassword: 'new-password', otp: 'rst_1' } },
      { path: '/api/auth/sessions?client_type=server', body: { email: 'ada@example.com', password: 'new-password' } },
    ]);
  });
});

describe('rate limits', () => {
  const from = (ip: string, path: string, body: unknown) =>
    handle(new Request(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `${ip}, 10.0.0.1` }, body: JSON.stringify(body) }));

  it('stops sign-in tries from one address past the limit, not from another', async () => {
    handle = createAdminHandler({ db, auth, rateLimits: { auth: [3, 600] } });
    for (let i = 0; i < 3; i++) expect((await from('1.2.3.4', '/auth/sign-in', { email: 'ada@example.com', password: 'wrong' })).status).toBe(401);
    const over = await from('1.2.3.4', '/auth/sign-in', { email: 'ada@example.com', password: 'old-password' });
    expect(over.status).toBe(429);
    expect(over.headers.get('retry-after')).toBe('600');
    expect((await from('5.6.7.8', '/auth/sign-in', { email: 'ada@example.com', password: 'old-password' })).status).toBe(200);
  });

  it('caps reset emails per address and invites per person', async () => {
    handle = createAdminHandler({ db, auth, beta: ['ada@example.com'], sendEmail: async (m) => void sent.push(m), rateLimits: { forgot: [2, 3600], invite: [1, 3600] } });
    for (let i = 0; i < 2; i++) expect((await post('/auth/forgot', { email: 'ada@example.com' })).status).toBe(200);
    expect((await post('/auth/forgot', { email: 'ada@example.com' })).status).toBe(429);
    const cookie = cookieOf(await post('/auth/sign-in', { email: 'ada@example.com', password: 'old-password' }));
    const { project } = await (await post('/projects', { name: 'Acme' }, cookie)).json();
    expect((await post(`/projects/${project.id}/invites`, { email: 'b@example.com' }, cookie)).status).toBe(201);
    expect((await post(`/projects/${project.id}/invites`, { email: 'c@example.com' }, cookie)).status).toBe(429);
  });

  it('caps reports filed from one address into a project', async () => {
    handle = createAdminHandler({ db, auth, beta: ['ada@example.com'], rateLimits: { file: [2, 600] } });
    const cookie = cookieOf(await post('/auth/sign-in', { email: 'ada@example.com', password: 'old-password' }));
    const { project } = await (await post('/projects', { name: 'Acme' }, cookie)).json();
    const fileFrom = (ip: string) => {
      const form = new FormData();
      for (const [k, v] of Object.entries({ type: 'bug', priority: 'high', area: 'other', description: 'The checkout button is grey' })) form.set(k, v);
      return handle(new Request(`${BASE}/p/${project.publicKey}/reports`, { method: 'POST', headers: { 'x-forwarded-for': ip }, body: form }));
    };
    expect((await fileFrom('9.9.9.9')).status).toBe(201);
    expect((await fileFrom('9.9.9.9')).status).toBe(201);
    expect((await fileFrom('9.9.9.9')).status).toBe(429);
    expect((await fileFrom('8.8.8.8')).status).toBe(201);
  });

  it('runs without limits, not without the admin, when the table is missing', async () => {
    await db.exec('DROP TABLE cloud_rate_limits');
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    handle = createAdminHandler({ db, auth, rateLimits: { auth: [1, 600] } });
    for (let i = 0; i < 3; i++) expect((await from('1.2.3.4', '/auth/sign-in', { email: 'ada@example.com', password: 'old-password' })).status).toBe(200);
    expect(quiet).toHaveBeenCalledTimes(1);
    quiet.mockRestore();
  });
});

describe('open sign-up', () => {
  it('lets anyone signed in create a project, where the beta list would not', async () => {
    ids.set('new@example.com', crypto.randomUUID());
    passwords.set('new@example.com', 'pw-123456');
    const signIn = async () => cookieOf(await post('/auth/sign-in', { email: 'new@example.com', password: 'pw-123456' }));
    handle = createAdminHandler({ db, auth, beta: ['ada@example.com'] });
    expect((await post('/projects', { name: 'Mine' }, await signIn())).status).toBe(403);
    handle = createAdminHandler({ db, auth, openSignup: true });
    const cookie = await signIn();
    expect((await (await handle(new Request(`${BASE}/me`, { headers: { cookie } }))).json()).canCreate).toBe(true);
    expect((await post('/projects', { name: 'Mine' }, cookie)).status).toBe(201);
  });
});
