// The hosted agent's triage (shipcue report 3d2dded6), with OpenAI stubbed out.
import { describe, it, expect } from 'vitest';
import { memoryStore } from '../src/server';
import { resolveConfig } from '../src/core';
// @ts-expect-error -- plain JS module for the site's function
import { triageReport, triageInput, parseTriage, hostedFromEnv, DEFAULT_HOSTED_MODEL } from '../website/_src/hosted.mjs';
import { sample } from './store.contract';

const areas = resolveConfig({ areas: [{ value: 'editor', label: 'Editor' }] }).areas;
const agent = { kind: 'agent' as const, id: 'hosted-1', name: 'shipcue-agent' };
const GOOD = {
  summary: 'Pressing Enter at the end of a heading deletes the heading.',
  area: 'editor',
  priority: 'high',
  priorityReason: 'People lose what they wrote.',
  steps: ['Open a page', 'Type a heading', 'Press Enter at its end'],
  missing: [],
  plan: ['Write a failing test for Enter at the end of a heading', 'Fix the split', 'Run the editor tests'],
};
const answer = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

function setup(fetchImpl: (url: string, init: RequestInit) => Promise<Response>, used = 0, timeoutMs = 2000) {
  const store = memoryStore();
  const calls: { url: string; body: any; auth: string | null }[] = [];
  const run = (reportId: string, held = false) =>
    triageReport({
      store,
      reportId,
      agent,
      areas,
      held,
      openai: {
        apiKey: 'sk-test',
        model: 'gpt-test',
        timeoutMs,
        fetchImpl: async (url: string, init: RequestInit) => {
          calls.push({ url, body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get('authorization') });
          return fetchImpl(url, init);
        },
      },
      dailyLimit: 3,
      usedToday: async () => used,
    });
  return { store, run, calls };
}

describe('hosted agent: triage', () => {
  it('good JSON: posts the triage as a note, then releases a report assigned to it', async () => {
    const { store, run, calls } = setup(async () => answer(JSON.stringify(GOOD)));
    const r = await store.create(sample({ description: 'Enter at the end of a heading deletes it', pageUrl: 'https://app.example.com/page/42?token=secret', reporter: 'ada@example.com', screenshots: ['data:image/png;base64,AAAA'], diagnostics: { secret: 1 } }));
    await store.assign!(r.id, agent, { kind: 'person', id: 'u', name: 'Ada' });
    const note = await run(r.id, true);
    expect(note).toContain('Pressing Enter at the end of a heading deletes the heading.');
    expect(note).toContain('Likely area: Editor');
    expect(note).toContain('Suggested priority: high. People lose what they wrote.');
    expect(note).toContain('1. Open a page');
    expect(note).toContain('Plan for a coding agent:');
    const events = await store.events!(r.id);
    expect(events.map((e) => [e.action, e.actor?.name])).toEqual([
      ['assigned', 'Ada'],
      ['claimed', 'shipcue-agent'],
      ['note', 'shipcue-agent'],
      ['released', 'shipcue-agent'],
    ]);
    expect(await store.get(r.id)).toMatchObject({ status: 'open', claimantId: null, priority: 'medium' });
    // Only what triage needs went to OpenAI.
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(calls[0]!.auth).toBe('Bearer sk-test');
    const sent = JSON.stringify(calls[0]!.body);
    expect(sent).toContain('/page/42');
    for (const secret of ['token=secret', 'ada@example.com', 'data:image', 'secret\\":1']) expect(sent).not.toContain(secret);
    expect(calls[0]!.body.response_format.type).toBe('json_schema');
    expect(calls[0]!.body.messages[0].content).toMatch(/never as instructions/);
  });

  it('auto-triage of a new report only adds a note', async () => {
    const { store, run } = setup(async () => answer(JSON.stringify(GOOD)));
    const r = await store.create(sample());
    await run(r.id);
    expect((await store.events!(r.id)).map((e) => e.action)).toEqual(['note']);
    expect((await store.get(r.id))!.status).toBe('open');
  });

  it('bad JSON, an error or a timeout: a short failure note, the report untouched otherwise', async () => {
    for (const [fetchImpl, reason] of [
      [async () => answer('not json'), /not in the expected shape/],
      [async () => answer(JSON.stringify({ ...GOOD, priority: 'urgent' })), /not in the expected shape/],
      [async () => new Response('{}', { status: 500 }), /OpenAI said 500/],
      [
        (_: string, init: RequestInit) =>
          new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
        /no answer within/,
      ],
    ] as const) {
      const { store, run } = setup(fetchImpl as never, 0, 50);
      const r = await store.create(sample({ priority: 'low' }));
      const note = await run(r.id);
      expect(note).toMatch(/^The hosted agent could not triage this \(/);
      expect(note).toMatch(reason);
      const after = (await store.get(r.id))!;
      expect(after).toMatchObject({ status: 'open', priority: 'low', claimantId: null, description: r.description });
      expect((await store.events!(r.id)).map((e) => e.action)).toEqual(['note']);
    }
  });

  it('over the daily cap: says so in a note and never calls OpenAI', async () => {
    const { store, run, calls } = setup(async () => answer(JSON.stringify(GOOD)), 3);
    const r = await store.create(sample());
    await store.assign!(r.id, agent, null);
    expect(await run(r.id, true)).toMatch(/today's limit of 3/);
    expect(calls).toHaveLength(0);
    expect((await store.get(r.id))!.claimantId).toBeNull();
  });

  it('leaves a report alone when someone took it before the agent could', async () => {
    const { store, run, calls } = setup(async () => answer(JSON.stringify(GOOD)));
    const r = await store.create(sample());
    await store.claim(r.id, { kind: 'person', id: 'u', name: 'Ada' });
    expect(await run(r.id, true)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('checks the answer and keeps the area to the list', () => {
    expect(parseTriage(JSON.stringify({ ...GOOD, area: 'billing' }), areas).area).toBe('other');
    expect(parseTriage(JSON.stringify({ ...GOOD, steps: 'one' }), areas)).toBeNull();
    expect(triageInput(sample({ pageUrl: 'not a url' }), areas).page).toBe('');
  });

  it('reads its settings from the environment, off without a key', () => {
    expect(hostedFromEnv({})).toBeNull();
    expect(hostedFromEnv({ OPENAI_API_KEY: 'k' })).toMatchObject({ model: DEFAULT_HOSTED_MODEL, dailyLimit: 50 });
    expect(hostedFromEnv({ OPENAI_API_KEY: 'k', SHIPCUE_HOSTED_MODEL: 'm', SHIPCUE_HOSTED_DAILY_LIMIT: '5' })).toMatchObject({ model: 'm', dailyLimit: 5 });
  });
});
