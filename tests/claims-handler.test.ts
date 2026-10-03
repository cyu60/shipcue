import { describe, it, expect } from 'vitest';
import { createShipcueHandler, memoryStore, type AgentIdentity, type TeamMember } from '../src/server';
import { resolveConfig, type Claimant } from '../src/core';
import { sample } from './store.contract';

const BASE = 'https://app.example.com/api/shipcue';
const config = resolveConfig();

const AGENTS: Record<string, AgentIdentity> = {
  'tok-claude': { id: 'agent-1', name: 'claude-code', leaseSeconds: 600 },
  'tok-codex': { id: 'agent-2', name: 'codex', pull: false, types: ['bug'] },
};
const MEMBERS: Record<string, TeamMember> = {
  ada: { id: 'ada@example.com', name: 'Ada', role: 'member' },
  vic: { id: 'vic@example.com', name: 'Vic', role: 'viewer' },
};
const CLAIMANTS: Claimant[] = [
  { kind: 'person', id: 'ada@example.com', name: 'Ada' },
  { kind: 'agent', id: 'agent-1', name: 'claude-code' },
  { kind: 'agent', id: 'agent-2', name: 'codex' },
];

function setup() {
  const store = memoryStore();
  const handle = createShipcueHandler({
    store,
    config,
    basePath: '/api/shipcue',
    agents: async (token) => AGENTS[token] ?? null,
    team: {
      getMember: async (req) => MEMBERS[req.headers.get('x-test-member') ?? ''] ?? null,
      claimants: async () => CLAIMANTS,
    },
  });
  return { store, handle };
}

const as = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
const member = (who: string) => ({ 'x-test-member': who, 'content-type': 'application/json' });
const call = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  new Request(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });

describe('agents with their own tokens', () => {
  it('claims under the agent\'s own name, with its lease', async () => {
    const { store, handle } = setup();
    const r = await store.create(sample());
    const res = await handle(call('POST', '/reports/next/claim', as('tok-claude'), { agent: 'spoofed' }));
    expect(res.status).toBe(200);
    const { report } = await res.json();
    expect(report).toMatchObject({ id: r.id, claimedBy: 'claude-code', claimantKind: 'agent', claimantId: 'agent-1' });
    expect(Date.parse(report.leaseExpiresAt)).toBeGreaterThan(Date.now() + 500_000);
  });

  it('refuses an unknown token', async () => {
    const { handle } = setup();
    expect((await handle(call('GET', '/reports', as('nope')))).status).toBe(401);
  });

  it('a push-mode agent only gets what is assigned to it, and only types it may take', async () => {
    const { store, handle } = setup();
    await store.create(sample());
    expect((await handle(call('POST', '/reports/next/claim', as('tok-codex')))).status).toBe(204);
    const task = await store.create(sample({ type: 'task' }));
    expect((await handle(call('POST', `/reports/${task.id}/claim`, as('tok-codex')))).status).toBe(403);
  });

  it('cannot close or release a report someone else now holds', async () => {
    const { store, handle } = setup();
    const r = await store.create(sample());
    await handle(call('POST', `/reports/${r.id}/claim`, as('tok-claude')));
    await store.assign!(r.id, CLAIMANTS[0]!, CLAIMANTS[0]!);
    expect((await handle(call('POST', `/reports/${r.id}/close`, as('tok-claude'), { status: 'fixed', resolution: 'x' }))).status).toBe(409);
    expect((await handle(call('POST', `/reports/${r.id}/release`, as('tok-claude')))).status).toBe(409);
  });

  it('heartbeat renews, review moves it to in_review with the PR, mine lists its work', async () => {
    const { store, handle } = setup();
    const r = await store.create(sample());
    await handle(call('POST', `/reports/${r.id}/claim`, as('tok-claude')));
    expect((await handle(call('POST', `/reports/${r.id}/heartbeat`, as('tok-claude')))).status).toBe(200);
    expect((await handle(call('POST', `/reports/${r.id}/review`, as('tok-claude'), { prUrl: 'javascript:alert(1)' }))).status).toBe(400);
    const res = await handle(call('POST', `/reports/${r.id}/review`, as('tok-claude'), { prUrl: 'https://github.com/o/r/pull/3' }));
    expect((await res.json()).report).toMatchObject({ status: 'in_review', prUrl: 'https://github.com/o/r/pull/3' });
    const mine = await (await handle(call('GET', '/reports?mine=1', as('tok-claude')))).json();
    expect(mine.reports.map((x: { id: string }) => x.id)).toEqual([r.id]);
    const events = await (await handle(call('GET', `/reports/${r.id}/events`, as('tok-claude')))).json();
    expect(events.events.map((e: { action: string }) => e.action)).toEqual(['claimed', 'review']);
  });

  it('releases expired claims before handing out work', async () => {
    const { store, handle } = setup();
    const r = await store.create(sample());
    await store.claim(r.id, CLAIMANTS[2]!, { leaseSeconds: -1 });
    const res = await handle(call('POST', '/reports/next/claim', as('tok-claude')));
    expect((await res.json()).report.id).toBe(r.id);
  });
});

describe('the team API (the CueLog)', () => {
  it('needs a signed-in member', async () => {
    const { handle } = setup();
    expect((await handle(call('GET', '/team/reports', {}))).status).toBe(401);
  });

  it('lists full reports and who can be assigned', async () => {
    const { store, handle } = setup();
    await store.create(sample({ screenshots: ['data:image/png;base64,AAA'] }));
    const me = await (await handle(call('GET', '/team/me', member('ada')))).json();
    expect(me.member.name).toBe('Ada');
    expect(me.claimants).toHaveLength(3);
    const { reports } = await (await handle(call('GET', '/team/reports', member('ada')))).json();
    expect(reports[0]).toMatchObject({ reporter: 'ada@example.com', diagnostics: { a: 1 } });
    // Data-URL screenshots become links the member can open.
    expect(reports[0].screenshots[0]).toMatch(/\/api\/shipcue\/team\/screenshot\/.+\/0$/);
    const shot = await handle(call('GET', new URL(reports[0].screenshots[0], BASE).pathname.replace('/api/shipcue', ''), member('ada')));
    expect(shot.headers.get('content-type')).toBe('image/png');
  });

  it('a member claims, assigns to an agent, and closes; the history shows each step', async () => {
    const { store, handle } = setup();
    const r = await store.create(sample());
    const claimed = await (await handle(call('POST', `/team/reports/${r.id}/claim`, member('ada')))).json();
    expect(claimed.report).toMatchObject({ claimedBy: 'Ada', claimantKind: 'person' });
    const assigned = await handle(call('POST', `/team/reports/${r.id}/assign`, member('ada'), { to: { kind: 'agent', id: 'agent-1' } }));
    expect((await assigned.json()).report).toMatchObject({ status: 'open', claimedBy: 'claude-code' });
    // Only someone on the claimant list.
    expect((await handle(call('POST', `/team/reports/${r.id}/assign`, member('ada'), { to: { kind: 'agent', id: 'evil' } }))).status).toBe(400);
    expect((await handle(call('POST', `/team/reports/${r.id}/priority`, member('ada'), { priority: 'blocking' }))).status).toBe(200);
    const closed = await handle(call('POST', `/team/reports/${r.id}/close`, member('ada'), { status: 'wontfix', resolution: 'dupe' }));
    expect((await closed.json()).report.status).toBe('wontfix');
    const detail = await (await handle(call('GET', `/team/reports/${r.id}`, member('ada')))).json();
    expect(detail.prompt).toContain('# Bug');
    expect(detail.events.map((e: { action: string; actor: { name: string } }) => [e.action, e.actor.name])).toEqual([
      ['claimed', 'Ada'],
      ['assigned', 'Ada'],
      ['priority', 'Ada'],
      ['closed', 'Ada'],
    ]);
    expect((await handle(call('POST', `/team/reports/${r.id}/reopen`, member('ada')))).status).toBe(200);
  });

  it('a viewer can read but not change anything', async () => {
    const { store, handle } = setup();
    const r = await store.create(sample());
    expect((await handle(call('GET', '/team/reports', member('vic')))).status).toBe(200);
    expect((await handle(call('POST', `/team/reports/${r.id}/claim`, member('vic')))).status).toBe(403);
  });

  it('says 409 with the holder when a claim loses', async () => {
    const { store, handle } = setup();
    const r = await store.create(sample());
    await store.claim(r.id, CLAIMANTS[1]!);
    const res = await handle(call('POST', `/team/reports/${r.id}/claim`, member('ada')));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('claude-code');
  });
});
