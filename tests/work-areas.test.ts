// Work-area claims (shipcue report 83f5d976, docs/swarm.md): a claim says what it touches, and
// shipcue warns when two active claims overlap. Never blocks; stored in the report's history.
import { readFileSync } from 'node:fs';
import { beforeAll, describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createShipcueHandler, memoryStore, postgresStore, type ReportStore, type TeamMember } from '../src/server';
import { currentScope, findConflicts, globsOverlap, resolveConfig, scopeOverlaps, validateScope, type ReportEvent, type WorkScope } from '../src/core';
import { createAgentClient } from '../src/mcp/client';
import { sample } from './store.contract';

const BASE = 'https://app.example.com/api/shipcue';
const ADA: TeamMember = { id: 'ada@example.com', name: 'Ada', role: 'member' };
const AGENTS: Record<string, { id: string; name: string }> = { 'tok-1': { id: 'a1', name: 'agent-one' }, 'tok-2': { id: 'a2', name: 'agent-two' } };

describe('globsOverlap', () => {
  it.each([
    ['src/server/**', 'src/server/handler.ts', true],
    ['src/server/**', 'src/react/CueLog.tsx', false],
    ['src/server', 'src/server/handler.ts', true], // a plain path covers what is under it
    ['src/server/', 'src/server/x/y.ts', true],
    ['./src/a.ts', '/src/a.ts', true],
    ['src/*.ts', 'src/a.ts', true],
    ['src/*.ts', 'src/a.tsx', false],
    ['src/*.ts', 'src/deep/a.ts', false], // a "*" stays inside one folder
    ['**/*.css', 'app/globals.css', true],
    ['**/*.css', 'app/page.tsx', false],
    ['src/**/test?.ts', 'src/a/b/test1.ts', true],
    ['src/*/handler.ts', 'src/**/handler.ts', true],
    ['src/a*.ts', 'src/*b.ts', true], // ab.ts matches both
    ['src/a*.ts', 'src/*b.tsx', false],
    ['migrations/2026*', 'migrations/2025*', false],
    ['src/a.ts', 'src/a.ts', true],
    ['src/a.ts', 'src/b.ts', false],
  ])('%s ~ %s → %s', (a, b, want) => {
    expect(globsOverlap(a, b)).toBe(want);
    expect(globsOverlap(b, a)).toBe(want);
  });

  it('stays fast on long patterns full of stars', () => {
    const a = `${'*a'.repeat(60)}/**`;
    const b = `${'a*'.repeat(60)}b`;
    const t = Date.now();
    globsOverlap(a, b);
    expect(Date.now() - t).toBeLessThan(500);
  });
});

describe('validateScope', () => {
  it('keeps the four fields, trimmed, and drops empty ones', () => {
    const r = validateScope({ areas: [' Sync ', ''], paths: ['src/server/**'], migration: ' 20261003190000 ', branch: 'swarm/x', other: 1 });
    expect(r).toEqual({ ok: true, value: { areas: ['Sync'], paths: ['src/server/**'], migration: '20261003190000', branch: 'swarm/x' } });
    expect(validateScope(null)).toEqual({ ok: true, value: null });
    expect(validateScope({})).toEqual({ ok: true, value: null });
  });
  it('refuses the wrong shapes and oversized ones', () => {
    expect(validateScope('src/**').ok).toBe(false);
    expect(validateScope({ paths: 'src/**' }).ok).toBe(false);
    expect(validateScope({ paths: Array(51).fill('a') }).ok).toBe(false);
    expect(validateScope({ branch: 'x'.repeat(201) }).ok).toBe(false);
    expect(validateScope({ migration: 3 }).ok).toBe(false);
  });
});

describe('scopeOverlaps and findConflicts', () => {
  it('same area (any case), overlapping paths, same migration slot, same branch', () => {
    const o = scopeOverlaps(
      { areas: ['Sync', 'editor'], paths: ['src/server/**'], migration: '2026100319', branch: 'b1' },
      { areas: ['sync'], paths: ['src/server/handler.ts', 'README.md'], migration: '2026100319', branch: 'b1' },
    );
    expect(o).toEqual([
      { kind: 'area', a: 'Sync', b: 'sync' },
      { kind: 'path', a: 'src/server/**', b: 'src/server/handler.ts' },
      { kind: 'migration', a: '2026100319', b: '2026100319' },
      { kind: 'branch', a: 'b1', b: 'b1' },
    ]);
    expect(scopeOverlaps({ areas: ['a'], migration: '1' }, { areas: ['b'], migration: '2' })).toEqual([]);
    expect(scopeOverlaps({}, { paths: ['**'] })).toEqual([]);
  });

  it('pairs each overlapping pair of claims once', () => {
    const side = (id: string, scope: WorkScope | null) => ({
      report: { ...sample(), id, status: 'claimed' as const, claimedBy: id, claimedAt: null, resolution: null, video: null, context: null, createdAt: '' },
      scope,
    });
    const out = findConflicts([side('r1', { paths: ['src/**'] }), side('r2', { paths: ['src/a.ts'] }), side('r3', { paths: ['docs/**'] }), side('r4', null)]);
    expect(out.active).toBe(4);
    expect(out.free).toBe(false);
    expect(out.conflicts).toHaveLength(1);
    expect(out.conflicts[0]).toMatchObject({ a: { id: 'r1', claimedBy: 'r1' }, b: { id: 'r2' }, overlaps: [{ kind: 'path' }] });
    expect(findConflicts([])).toEqual({ active: 0, free: true, conflicts: [] });
  });

  it("a report's scope is the newest one since its holder took it", () => {
    const e = (action: ReportEvent['action'], detail: Record<string, unknown> = {}): ReportEvent => ({ id: '', reportId: 'r', action, actor: null, detail, at: '' });
    expect(currentScope([e('claimed', { scope: { areas: ['a'] } })])).toEqual({ areas: ['a'] });
    expect(currentScope([e('claimed', { scope: { areas: ['a'] } }), e('note', { text: 'x', scope: { areas: ['b'] } }), e('review')])).toEqual({ areas: ['b'] });
    expect(currentScope([e('claimed', { scope: { areas: ['a'] } }), e('note', { text: 'plain note' })])).toEqual({ areas: ['a'] });
    expect(currentScope([e('claimed', { scope: { areas: ['a'] } }), e('released'), e('claimed')])).toBeNull();
    expect(currentScope([e('claimed', { scope: { areas: ['a'] } }), e('note', { text: 'cleared', scope: null })])).toBeNull();
    expect(currentScope([])).toBeNull();
  });
});

function handlerFor(store: ReportStore) {
  const handle = createShipcueHandler({
    store,
    config: resolveConfig(),
    agentToken: 'shared',
    agents: async (t) => AGENTS[t] ?? null,
    team: { getMember: async (req) => (req.headers.get('x-test-member') ? ADA : null) },
  });
  const call = (method: string, path: string, token: string | null, body?: unknown, headers: Record<string, string> = {}) =>
    handle(
      new Request(BASE + path, {
        method,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  return { handle, call };
}

// One database for the file (PGlite takes seconds to start), emptied before each use.
let shared: Promise<{ query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }> | null = null;
async function pgStores() {
  shared ??= (async () => {
    const db = new PGlite();
    await db.exec(readFileSync(new URL('../sql/schema.sql', import.meta.url), 'utf8'));
    await db.exec(readFileSync(new URL('../sql/cloud.sql', import.meta.url), 'utf8'));
    return { query: (text: string, params?: unknown[]) => db.query(text, params) };
  })();
  const q = await shared;
  await q.query('TRUNCATE shipcue_reports, shipcue_report_events');
  return { q, own: postgresStore(q) };
}
beforeAll(() => pgStores(), 60_000);

const STORES: Array<[string, () => Promise<ReportStore>]> = [
  ['memory', async () => memoryStore()],
  ['postgres', async () => (await pgStores()).own],
];

describe.each(STORES)('work-area claims on the %s store', (_name, makeStore) => {
  it('stores a scope given on claim, warns about overlaps, never blocks', async () => {
    const store = await makeStore();
    const { call } = handlerFor(store);
    const r1 = await store.create(sample({ description: 'one' }));
    const r2 = await store.create(sample({ description: 'two' }));

    const first = await call('POST', `/reports/${r1.id}/claim`, 'tok-1', { scope: { areas: ['server'], paths: ['src/server/**'], migration: '2026100319' } });
    expect(first.status).toBe(200);
    const f = await first.json();
    expect(f.report.status).toBe('claimed');
    expect(f.conflicts).toBeUndefined();

    const second = await call('POST', `/reports/${r2.id}/claim`, 'tok-2', { scope: { paths: ['src/server/handler.ts'], migration: '2026100319' } });
    expect(second.status).toBe(200);
    const s = await second.json();
    expect(s.report.claimantId).toBe('a2');
    expect(s.warning).toMatch(/overlaps/i);
    expect(s.warning).toContain(r1.id.slice(0, 8));
    expect(s.conflicts).toHaveLength(1);
    expect(s.conflicts[0].overlaps.map((o: { kind: string }) => o.kind)).toEqual(['path', 'migration']);

    const claimed = (await store.events!(r1.id)).find((e) => e.action === 'claimed')!;
    expect(claimed.detail.scope).toEqual({ areas: ['server'], paths: ['src/server/**'], migration: '2026100319' });

    const list = await (await call('GET', '/reports/conflicts', 'tok-1')).json();
    expect(list).toMatchObject({ active: 2, free: false });
    expect(list.conflicts).toHaveLength(1);
    expect([list.conflicts[0].a.id, list.conflicts[0].b.id].sort()).toEqual([r1.id, r2.id].sort());
  });

  it('claim_next takes a scope too, and a bad scope is a 400 that claims nothing', async () => {
    const store = await makeStore();
    const { call } = handlerFor(store);
    const r = await store.create(sample());
    expect((await call('POST', '/reports/next/claim', 'tok-1', { scope: { paths: 'src/**' } })).status).toBe(400);
    expect((await store.get(r.id))!.status).toBe('open');
    const res = await call('POST', '/reports/next/claim', 'tok-1', { scope: { branch: 'swarm/one' } });
    expect((await res.json()).report.id).toBe(r.id);
    expect((await store.events!(r.id)).at(-1)!.detail.scope).toEqual({ branch: 'swarm/one' });
  });

  it('reports/:id/scope changes it for the holder only, as a note in the history', async () => {
    const store = await makeStore();
    const { call } = handlerFor(store);
    const r1 = await store.create(sample());
    const r2 = await store.create(sample());
    await call('POST', `/reports/${r1.id}/claim`, 'tok-1', {});
    await call('POST', `/reports/${r2.id}/claim`, 'tok-2', { scope: { areas: ['editor'] } });

    expect((await call('POST', `/reports/${r1.id}/scope`, 'tok-2', { scope: { areas: ['editor'] } })).status).toBe(409);
    const put = await call('PUT', `/reports/${r1.id}/scope`, 'tok-1', { scope: { areas: ['Editor'] } });
    expect(put.status).toBe(200);
    const body = await put.json();
    expect(body.scope).toEqual({ areas: ['Editor'] });
    expect(body.conflicts).toHaveLength(1);
    const note = (await store.events!(r1.id)).at(-1)!;
    expect(note).toMatchObject({ action: 'note', actor: { id: 'a1' }, detail: { scope: { areas: ['Editor'] } } });
    expect(String(note.detail.text)).toContain('Editor');

    // Cleared: no more overlap.
    const cleared = await call('POST', `/reports/${r1.id}/scope`, 'tok-1', { scope: null });
    expect((await cleared.json()).conflicts).toEqual([]);
    expect((await (await call('GET', '/reports/conflicts', 'tok-1')).json()).conflicts).toEqual([]);
    // Open reports have no claim to scope.
    const r3 = await store.create(sample());
    expect((await call('POST', `/reports/${r3.id}/scope`, 'tok-1', { scope: { areas: ['x'] } })).status).toBe(409);
  });

  it('in review still counts; released, fixed and reclaimed-without-scope do not; free when nothing is held', async () => {
    const store = await makeStore();
    const { call } = handlerFor(store);
    const r1 = await store.create(sample());
    const r2 = await store.create(sample());
    await call('POST', `/reports/${r1.id}/claim`, 'tok-1', { scope: { branch: 'b' } });
    await call('POST', `/reports/${r2.id}/claim`, 'tok-2', { scope: { branch: 'b' } });
    await call('POST', `/reports/${r1.id}/review`, 'tok-1', { prUrl: 'https://github.com/o/r/pull/1' });
    expect((await (await call('GET', '/reports/conflicts', 'tok-1')).json()).conflicts).toHaveLength(1);

    await call('POST', `/reports/${r2.id}/release`, 'tok-2');
    await call('POST', `/reports/${r2.id}/claim`, 'tok-2', {});
    expect((await (await call('GET', '/reports/conflicts', 'tok-1')).json()).conflicts).toHaveLength(0);

    await call('POST', `/reports/${r1.id}/close`, 'tok-1', { status: 'fixed' });
    await call('POST', `/reports/${r2.id}/close`, 'tok-2', { status: 'wontfix' });
    expect(await (await call('GET', '/reports/conflicts', 'tok-1')).json()).toEqual({ active: 0, free: true, conflicts: [] });
  });

  it('team/conflicts for signed-in members; the agent route needs a token', async () => {
    const store = await makeStore();
    const { call } = handlerFor(store);
    const r1 = await store.create(sample());
    const r2 = await store.create(sample());
    await call('POST', `/reports/${r1.id}/claim`, 'tok-1', { scope: { areas: ['x'] } });
    await call('POST', `/reports/${r2.id}/claim`, 'tok-2', { scope: { areas: ['x'] } });
    expect((await call('GET', '/reports/conflicts', null)).status).toBe(401);
    expect((await call('GET', '/team/conflicts', null)).status).toBe(401);
    const team = await (await call('GET', '/team/conflicts', null, undefined, { 'x-test-member': '1' })).json();
    expect(team.conflicts).toHaveLength(1);
  });
});

describe('conflicts stay inside one Cloud project', () => {
  it('two projects with the same scopes never see each other', async () => {
    const { q } = await pgStores();
    const A = postgresStore(q, 'shipcue_reports', { project: '00000000-0000-4000-8000-00000000000a' });
    const B = postgresStore(q, 'shipcue_reports', { project: '00000000-0000-4000-8000-00000000000b' });
    const own = postgresStore(q, 'shipcue_reports', { project: null });
    for (const s of [A, B, own]) {
      const r = await s.create(sample());
      await s.claim(r.id, { kind: 'agent', id: 'bot', name: 'bot' }, { scope: { paths: ['src/**'] } });
    }
    const a2 = await A.create(sample());
    await A.claim(a2.id, { kind: 'agent', id: 'bot2', name: 'bot2' }, { scope: { paths: ['src/a.ts'] } });
    for (const [s, n] of [[A, 1], [B, 0], [own, 0]] as const) {
      const { call } = handlerFor(s);
      const out = await (await call('GET', '/reports/conflicts', 'shared')).json();
      expect(out.conflicts).toHaveLength(n);
    }
    expect((await B.scopes!()).length).toBe(1);
  });
});

describe('MCP client', () => {
  it('claim and claimNext send a scope and return the warning; setScope and conflicts work', async () => {
    const store = memoryStore();
    const { handle } = handlerFor(store);
    const fetch = (u: string, i?: RequestInit) => handle(new Request(u, i));
    const one = createAgentClient({ url: BASE, token: 'tok-1', fetch });
    const two = createAgentClient({ url: BASE, token: 'tok-2', fetch, scope: { migration: '42' } });
    const r1 = await store.create(sample());
    const r2 = await store.create(sample());
    const a = await one.claim(r1.id, { migration: '42' });
    expect(a.warning).toBeUndefined();
    const b = await two.claimNext(); // falls back to the client's default scope
    expect(b!.report.id).toBe(r2.id);
    expect(b!.warning).toContain(r1.id.slice(0, 8));
    expect((await two.conflicts()).conflicts).toHaveLength(1);
    const set = await two.setScope(r2.id, { migration: '43' });
    expect(set.conflicts).toEqual([]);
    expect((await one.conflicts()).free).toBe(false);
  });
});

describe('shipcue-listen --scope', () => {
  it('checks the JSON and hands on a normalised SHIPCUE_SCOPE', async () => {
    const { parseScopeFlag } = await import('../src/mcp/events');
    expect(parseScopeFlag(undefined)).toEqual({ ok: true, value: undefined });
    expect(parseScopeFlag('{"paths":[" src/server/** "],"x":1}')).toEqual({ ok: true, value: '{"paths":["src/server/**"]}' });
    expect(parseScopeFlag('{}')).toEqual({ ok: true, value: undefined });
    expect(parseScopeFlag('src/**').ok).toBe(false);
    expect(parseScopeFlag('{"areas":"sync"}').ok).toBe(false);
  });
});
