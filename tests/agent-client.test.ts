import { describe, it, expect } from 'vitest';
import { createAgentClient } from '../src/mcp/client';
import { createShipcueHandler, memoryStore } from '../src/server';

async function setup() {
  const store = memoryStore();
  const handler = createShipcueHandler({ store, agentToken: 'secret' });
  const fetchVia = (url: string | URL | Request, init?: RequestInit) => handler(new Request(url, init));
  const client = createAgentClient({ url: 'https://app.example.com/api/shipcue', token: 'secret', agent: 'claude', fetch: fetchVia });
  const add = (priority: 'low' | 'blocking') =>
    store.create({
      type: 'bug',
      priority,
      area: 'other',
      description: `A ${priority} problem on the page`,
      pageUrl: '',
      userAgent: '',
      diagnostics: {},
      reporter: null,
      screenshots: [],
    });
  return { store, client, add };
}

describe('agent client (what the MCP tools call)', () => {
  it('lists the open queue', async () => {
    const { client, add } = await setup();
    await add('low');
    const top = await add('blocking');
    expect((await client.list('open'))[0]?.id).toBe(top.id);
  });

  it('claims the next report as this agent and gets a prompt', async () => {
    const { client, add } = await setup();
    const r = await add('blocking');
    const claimed = await client.claimNext();
    expect(claimed?.report).toMatchObject({ id: r.id, claimedBy: 'claude' });
    expect(claimed?.prompt).toContain('## What to do');
    expect(await client.claimNext()).toBeNull();
  });

  it('closes and releases', async () => {
    const { client, add } = await setup();
    const a = await add('low');
    const b = await add('low');
    await client.claim(a.id);
    expect((await client.close(a.id, 'fixed', 'PR #2')).status).toBe('fixed');
    await client.claim(b.id);
    expect((await client.release(b.id)).status).toBe('open');
  });

  it('surfaces API errors with their message', async () => {
    const { client, add } = await setup();
    const r = await add('low');
    await client.claim(r.id);
    await expect(client.claim(r.id)).rejects.toThrow('has it now');
  });

  it('fails clearly on a wrong token', async () => {
    const store = memoryStore();
    const handler = createShipcueHandler({ store, agentToken: 'secret' });
    const client = createAgentClient({
      url: 'https://x/api/shipcue',
      token: 'wrong',
      fetch: (u, i) => handler(new Request(u, i)),
    });
    await expect(client.list()).rejects.toThrow('Unauthorized');
  });

  it('reviews with a PR, lists its own work, and reads the history', async () => {
    const { client, add } = await setup();
    const r = await add('blocking');
    await client.claim(r.id);
    expect((await client.mine()).map((x) => x.id)).toEqual([r.id]);
    expect((await client.heartbeat(r.id)).status).toBe('claimed');
    expect(await client.review(r.id, 'https://github.com/o/r/pull/9')).toMatchObject({ status: 'in_review', prUrl: 'https://github.com/o/r/pull/9' });
    expect((await client.close(r.id, 'fixed', 'merged', 'https://github.com/o/r/pull/9')).status).toBe('fixed');
    expect((await client.events(r.id)).map((e) => e.action)).toEqual(['claimed', 'review', 'closed']);
  });
});
