import { describe, it, expect } from 'vitest';
import { createShipcueHandler, memoryStore } from '../src/server';

const BASE = 'https://app.example.com/api/shipcue';
const form = (extra: Record<string, string> = {}) => {
  const f = new FormData();
  for (const [k, v] of Object.entries({ type: 'bug', priority: 'medium', area: 'other', description: 'Something broke on the page', ...extra })) f.set(k, v);
  return f;
};

function setup() {
  const store = memoryStore();
  const handle = createShipcueHandler({
    store,
    getReporter: async (req) => req.headers.get('x-user'),
    anonymousLimit: 3,
    signInUrl: (req) => `/app/?next=${encodeURIComponent(new URL(req.headers.get('referer') ?? 'https://app.example.com/').pathname)}`,
    agentToken: 'secret',
  });
  const file = (headers: Record<string, string>, extra?: Record<string, string>) =>
    handle(new Request(`${BASE}/reports`, { method: 'POST', body: form(extra), headers }));
  return { store, file };
}

describe('signed-out reports are capped per person (report dce33fd0)', () => {
  it('takes 3 from one person, then asks them to sign in', async () => {
    const { file } = setup();
    const ip = { 'x-forwarded-for': '203.0.113.9, 10.0.0.1', referer: 'https://app.example.com/docs/' };
    for (let i = 0; i < 3; i++) expect((await file(ip)).status).toBe(201);
    const res = await file(ip);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ signIn: '/app/?next=%2Fdocs%2F', error: expect.stringContaining('Sign in') });
    // Someone else is not held back.
    expect((await file({ 'x-forwarded-for': '198.51.100.4' })).status).toBe(201);
  });

  it('signed in, there is no cap, and they can still stay anonymous', async () => {
    const { store, file } = setup();
    const ip = { 'x-forwarded-for': '203.0.113.9' };
    for (let i = 0; i < 3; i++) await file(ip);
    const res = await file({ ...ip, 'x-user': 'ada@example.com' }, { anonymous: '1' });
    expect(res.status).toBe(201);
    const { id } = await res.json();
    expect((await store.get(id))?.reporter).toBeNull();
    const named = await (await file({ ...ip, 'x-user': 'ada@example.com' })).json();
    expect((await store.get(named.id))?.reporter).toBe('ada@example.com');
  });

  it('never stores the address itself', async () => {
    const { store, file } = setup();
    const { id } = await (await file({ 'x-forwarded-for': '203.0.113.9' })).json();
    expect(JSON.stringify(await store.get(id))).not.toContain('203.0.113.9');
  });
});
