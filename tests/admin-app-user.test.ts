// The admin on the app's own sign-in (getUser) and serving its own page (page: true), with no InsForge.
import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createAdminHandler, insforgeAuth } from '../src/admin';

const schema = readFileSync(new URL('../sql/schema.sql', import.meta.url), 'utf8');
const cloud = readFileSync(new URL('../sql/cloud.sql', import.meta.url), 'utf8');
const ORIGIN = 'https://app.example.com';

let db: PGlite;
let handle: (req: Request) => Promise<Response>;

// The app's session, as a header the test sets: "<id>|<email>|<name>".
const getUser = (req: Request) => {
  const [id, email, name] = (req.headers.get('x-test-user') ?? '').split('|');
  return id && email ? { id, email, ...(name ? { name } : {}) } : null;
};
const as = (user: string | null, path: string, body?: unknown) =>
  handle(
    new Request(`${ORIGIN}/admin${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(user ? { 'x-test-user': user } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
const ADA = '42|ada@example.com|Ada Lovelace';

beforeEach(async () => {
  db = new PGlite();
  await db.exec(schema);
  await db.exec(cloud);
  handle = createAdminHandler({ db, base: '/admin', page: true, getUser, signInUrl: '/login', beta: ['ada@example.com'] });
});

describe('admin with getUser', () => {
  it('takes exactly one of getUser and auth', () => {
    expect(() => createAdminHandler({ db, base: '/admin' })).toThrow(/getUser/);
    expect(() => createAdminHandler({ db, getUser, auth: insforgeAuth('https://x.example.com') })).toThrow(/not both/);
  });

  it("reads the app's user, with a stable uuid for an id that is not one", async () => {
    const a = await (await as(ADA, '/me')).json();
    const b = await (await as(ADA, '/me')).json();
    expect(a.session).toBe('app');
    expect(a.user.email).toBe('ada@example.com');
    expect(a.user.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(b.user.id).toBe(a.user.id);
    expect(a.canCreate).toBe(true);
  });

  it('makes a project, names the owner as the app does, and serves its team API', async () => {
    const made = await as(ADA, '/projects', { name: 'Demo' });
    expect(made.status).toBe(201);
    const { project } = await made.json();
    const detail = await (await as(ADA, `/projects/${project.id}`)).json();
    expect(detail.members).toEqual([expect.objectContaining({ email: 'ada@example.com', name: 'Ada Lovelace', role: 'owner' })]);
    const team = await as(ADA, `/p/${project.publicKey}/team/me`);
    expect(team.status).toBe(200);
    expect((await team.json()).member).toMatchObject({ name: 'Ada Lovelace', role: 'owner' });
    expect((await as('7|eve@example.com', `/p/${project.publicKey}/team/me`)).status).toBe(401);
  });

  it("sends a signed-out person to the app's sign-in, and has no sign-in of its own", async () => {
    const res = await as(null, '/me');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Sign in first.', signIn: '/login' });
    expect((await as(null, '/auth/sign-in', { email: 'ada@example.com', password: 'whatever1' })).status).toBe(404);
    expect((await as(ADA, '/auth/sign-out', {})).status).toBe(404);
    expect((await as(null, '/auth/oauth/google')).status).toBe(404);
  });
});

describe('admin page', () => {
  it('serves the page at its base, pointed at the handler', async () => {
    for (const path of ['', '/']) {
      const res = await as(null, path);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/text\/html/);
      const html = await res.text();
      expect(html).toContain('<div id="shipcue-app" data-api="/admin">');
      expect(html).toMatch(/<script src="\/admin\/app\.js\?v=[^"]+" defer>/);
    }
  });

  it('serves the script', async () => {
    const res = await as(null, '/app.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/javascript/);
    expect((await res.text()).length).toBeGreaterThan(10_000);
  }, 30_000);

  it('is off unless asked for', async () => {
    const plain = createAdminHandler({ db, base: '/admin', getUser });
    const signedIn = { headers: { 'x-test-user': ADA } };
    expect((await plain(new Request(`${ORIGIN}/admin/`, signedIn))).status).toBe(404);
    expect((await plain(new Request(`${ORIGIN}/admin/app.js`, signedIn))).status).toBe(404);
  });
});
