// Notes on a report (shipcue report 3d2dded6): the team API, the agent API and the MCP client.
import { describe, it, expect } from 'vitest';
import { createShipcueHandler, memoryStore, type TeamMember } from '../src/server';
import { resolveConfig } from '../src/core';
import { createAgentClient } from '../src/mcp/client';
import { sample } from './store.contract';

const BASE = 'https://app.example.com/api/shipcue';
const MEMBERS: Record<string, TeamMember> = {
  ada: { id: 'ada@example.com', name: 'Ada', role: 'member' },
  vic: { id: 'vic@example.com', name: 'Vic', role: 'viewer' },
};

function setup() {
  const store = memoryStore();
  const handle = createShipcueHandler({
    store,
    config: resolveConfig({ maxNote: 50 }),
    agentToken: 'shared',
    agents: async (t) => (t === 'tok-claude' ? { id: 'agent-1', name: 'claude-code' } : null),
    team: { getMember: async (req) => MEMBERS[req.headers.get('x-test-member') ?? ''] ?? null },
  });
  const post = (path: string, headers: Record<string, string>, body: unknown) =>
    handle(new Request(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }));
  return { store, handle, post };
}

describe('notes', () => {
  it('members add notes from the CueLog; viewers cannot', async () => {
    const { store, post } = setup();
    const r = await store.create(sample());
    const res = await post(`/team/reports/${r.id}/note`, { 'x-test-member': 'ada' }, { text: '  Seen it on Safari too  ' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.event).toMatchObject({ action: 'note', actor: { kind: 'person', name: 'Ada' }, detail: { text: 'Seen it on Safari too' } });
    expect(body.report.id).toBe(r.id);
    expect((await post(`/team/reports/${r.id}/note`, { 'x-test-member': 'vic' }, { text: 'hi' })).status).toBe(403);
    expect((await post(`/team/reports/${r.id}/note`, {}, { text: 'hi' })).status).toBe(401);
    expect((await store.events!(r.id)).filter((e) => e.action === 'note')).toHaveLength(1);
  });

  it('refuses empty and too-long notes (config.maxNote) and unknown reports', async () => {
    const { store, post } = setup();
    const r = await store.create(sample());
    expect((await post(`/team/reports/${r.id}/note`, { 'x-test-member': 'ada' }, { text: '   ' })).status).toBe(400);
    const long = await post(`/team/reports/${r.id}/note`, { 'x-test-member': 'ada' }, { text: 'x'.repeat(51) });
    expect(long.status).toBe(400);
    expect((await long.json()).error).toContain('50');
    expect((await post(`/team/reports/${crypto.randomUUID()}/note`, { 'x-test-member': 'ada' }, { text: 'hi' })).status).toBe(404);
  });

  it('agents note under their own name, and need a token', async () => {
    const { store, post } = setup();
    const r = await store.create(sample());
    const res = await post(`/reports/${r.id}/note`, { authorization: 'Bearer tok-claude' }, { text: 'Cannot reproduce', agent: 'spoofed' });
    expect(res.status).toBe(201);
    expect((await res.json()).event.actor).toEqual({ kind: 'agent', id: 'agent-1', name: 'claude-code' });
    expect((await post(`/reports/${r.id}/note`, {}, { text: 'x' })).status).toBe(401);
    expect((await post(`/reports/${r.id}/note`, { authorization: 'Bearer tok-claude' }, {})).status).toBe(400);
    expect((await store.get(r.id))!.status).toBe('open');
  });

  it('the MCP client (add_note) posts a note as the agent it is', async () => {
    const { store, handle } = setup();
    const r = await store.create(sample());
    const client = createAgentClient({ url: BASE, token: 'shared', agent: 'codex', fetch: (u, i) => handle(new Request(u, i)) });
    const e = await client.note(r.id, 'Needs a screenshot of the error');
    expect(e).toMatchObject({ action: 'note', actor: { name: 'codex' }, detail: { text: 'Needs a screenshot of the error' } });
    expect((await client.events(r.id)).map((x) => x.action)).toEqual(['note']);
  });
});
