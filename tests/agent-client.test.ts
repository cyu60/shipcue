import { describe, it, expect } from 'vitest';
import { createAgentClient, DUPLICATE_CHOICES, duplicateText, filedText, LikelyDuplicateError } from '../src/mcp/client';
import { createShipcueHandler, memoryStore } from '../src/server';
import { resolveConfig } from '../src/core';

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

describe('file() (the file_report MCP tool, report 9f533ece)', () => {
  it('posts the report as multipart to {url}/reports, server-side', async () => {
    const store = memoryStore();
    const handler = createShipcueHandler({ store, agentToken: 'secret', config: resolveConfig({ areas: [{ value: 'billing', label: 'Billing' }] }) });
    const seen: Request[] = [];
    const client = createAgentClient({
      url: 'https://app.example.com/api/shipcue/',
      token: 'secret',
      fetch: (u, i) => {
        const req = new Request(u, i);
        seen.push(req.clone());
        return handler(req);
      },
    });
    const { id } = await client.file({
      type: 'feature',
      description: 'Export invoices as CSV, same columns as the table',
      priority: 'high',
      area: 'billing',
      pageUrl: 'https://app.example.com/billing',
      context: 'Invoice #42',
      diagnostics: '{"plan":"pro"}',
      reporter: 'ana@example.com',
    });
    const req = seen[0]!;
    expect(req.url).toBe('https://app.example.com/api/shipcue/reports');
    expect(req.method).toBe('POST');
    expect(req.headers.get('content-type')).toMatch(/^multipart\/form-data/);
    expect(req.headers.get('authorization')).toBe('Bearer secret');
    expect(req.headers.get('x-shipcue-user')).toBe('ana@example.com');
    const form = await req.formData();
    expect(Object.fromEntries(form.entries())).toMatchObject({
      type: 'feature',
      priority: 'high',
      area: 'billing',
      description: 'Export invoices as CSV, same columns as the table',
      pageUrl: 'https://app.example.com/billing',
      context: 'Invoice #42',
      diagnostics: '{"plan":"pro"}',
    });
    expect(await store.get(id)).toMatchObject({ type: 'feature', priority: 'high', area: 'billing', diagnostics: { plan: 'pro' } });
  });

  it('files without a token, and says why when the handler refuses', async () => {
    const store = memoryStore();
    const handler = createShipcueHandler({ store });
    const client = createAgentClient({ url: 'https://x/api/shipcue', fetch: (u, i) => handler(new Request(u, i)) });
    const { id } = await client.file({ type: 'bug', description: 'The save button does nothing on Safari' });
    expect((await store.get(id))?.priority).toBe('medium');
    await expect(client.file({ type: 'bug', description: 'short' })).rejects.toThrow();
  });
});

describe('file() and a likely duplicate (Habitect report db7cb16c)', () => {
  const match = { id: 'r-earlier', status: 'fixed', description: 'Enter drops the heading', resolution: 'Enter keeps it now' };
  const hint = 'This looks like report r-earlier. Send it again with addAsNote, reopen or fileAnyway.';

  /** A host that dedupes: a close match is answered 409 until the sender chooses. */
  function dedupingHost() {
    const forms: Record<string, string>[] = [];
    const fetch = async (_u: string, i?: RequestInit) => {
      const form = Object.fromEntries((i!.body as FormData).entries()) as Record<string, string>;
      forms.push(form);
      if (form.addAsNote === '1' || form.reopen === '1') {
        return Response.json({ id: match.id, duplicateOf: match.id, addedAsNote: true, reopened: form.reopen === '1' });
      }
      if (form.fileAnyway === '1') return Response.json({ id: 'r-new' });
      return Response.json({ error: 'LIKELY_DUPLICATE', confirm: true, duplicateOf: match.id, match, related: [match], hint }, { status: 409 });
    };
    return { forms, client: createAgentClient({ url: 'https://x/api', agent: 'claude', fetch }) };
  }

  it('says it can answer a close match, so the host asks instead of filing a duplicate', async () => {
    const { forms, client } = dedupingHost();
    const error = await client.file({ type: 'bug', description: 'Enter at the end of a heading drops it' }).catch((e: unknown) => e);
    expect(forms[0]).toMatchObject({ canConfirm: '1', userAgent: 'shipcue-mcp (claude)' });
    expect(error).toBeInstanceOf(LikelyDuplicateError);
    expect(error).toMatchObject({ duplicateOf: 'r-earlier', match, hint, message: 'LIKELY_DUPLICATE' });
  });

  it('writes the match and the three ways on for the agent', () => {
    const text = duplicateText(new LikelyDuplicateError({ duplicateOf: match.id, match, hint }));
    expect(text).toContain('r-earlier');
    expect(text).toContain('Enter drops the heading');
    expect(text).toContain('fixed');
    expect(text).toContain('Enter keeps it now');
    for (const choice of DUPLICATE_CHOICES) expect(text).toContain(choice);
  });

  it('files it anyway with fileAnyway (and force, for hosts that read that)', async () => {
    const { forms, client } = dedupingHost();
    expect(await client.file({ type: 'bug', description: 'Enter at the end of a heading drops it', ifDuplicate: 'fileAnyway' })).toEqual({ id: 'r-new' });
    expect(forms[0]).toMatchObject({ fileAnyway: '1', force: '1' });
  });

  it('adds it to the match as a note, or reopens it, and says so', async () => {
    const { forms, client } = dedupingHost();
    const noted = await client.file({ type: 'bug', description: 'Enter at the end of a heading drops it', ifDuplicate: 'addAsNote' });
    expect(noted).toEqual({ id: 'r-earlier', duplicateOf: 'r-earlier', addedAsNote: true, reopened: false });
    expect(filedText(noted)).toBe('Added as a note to r-earlier, which it repeats.');
    const reopened = await client.file({ type: 'bug', description: 'Enter at the end of a heading drops it', ifDuplicate: 'reopen' });
    expect(forms[1]).toMatchObject({ reopen: '1' });
    expect(filedText(reopened)).toBe('Added as a note to r-earlier, which it repeats, and reopened it.');
    expect(filedText({ id: 'r-new' })).toBe('Filed r-new.');
  });
});
