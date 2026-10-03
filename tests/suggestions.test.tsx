// @vitest-environment jsdom
// One-click suggestions and duplicate detection (shipcue report 1c0bf5be): the hosted agent's triage
// carries structured suggestions (priority, area, "looks like #id") stored with its note, the CueLog
// drawer shows them as Apply chips, and Merge folds a duplicate into the original.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { PGlite } from '@electric-sql/pglite';
import { CueLogTable, readSuggestion } from '../src/react';
import { createShipcueHandler, memoryStore, postgresStore, type ReportStore, type TeamMember } from '../src/server';
import { resolveConfig, type Claimant } from '../src/core';
// @ts-expect-error -- plain JS module for the site's function
import { triageReport, hostedFromEnv } from '../website/_src/hosted.mjs';
import { sample } from './store.contract';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

const config = resolveConfig({ areas: [{ value: 'editor', label: 'Editor' }, { value: 'billing', label: 'Billing' }] });
const areas = config.areas;
const agent = { kind: 'agent' as const, id: 'hosted-1', name: 'shipcue-agent' };
const ADA: TeamMember = { id: 'ada@example.com', name: 'Ada', role: 'member' };
const CLAIMANTS: Claimant[] = [{ kind: 'person', id: 'ada@example.com', name: 'Ada' }];
const GOOD = {
  summary: 'Saving does nothing.',
  area: 'editor',
  priority: 'high',
  priorityReason: 'People lose work.',
  steps: [],
  missing: [],
  plan: ['Fix it'],
  duplicateOf: '',
};
const answer = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

function triage(store: ReportStore, reportId: string, reply: Record<string, unknown>, candidates?: number) {
  const calls: any[] = [];
  const run = triageReport({
    store,
    reportId,
    agent,
    areas,
    candidates,
    openai: {
      apiKey: 'sk-test',
      model: 'gpt-test',
      timeoutMs: 2000,
      fetchImpl: async (_url: string, init: RequestInit) => {
        calls.push(JSON.parse(String(init.body)));
        return answer(JSON.stringify(reply));
      },
    },
    dailyLimit: 10,
    usedToday: async () => 0,
  });
  return run.then((note: string) => ({ note, calls }));
}

describe('hosted agent: suggestions and duplicates', () => {
  it('sends a compact list of open reports and stores the suggestions with the note', async () => {
    const store = memoryStore();
    const original = await store.create(sample({ description: 'Save button does nothing\nOn Safari, every time', reporter: 'bob@example.com' }));
    const closed = await store.create(sample({ description: 'An old closed one' }));
    await store.close(closed.id, 'fixed', null);
    const r = await store.create(sample({ description: 'Clicking save is broken', priority: 'medium', area: 'other' }));
    const { note, calls } = await triage(store, r.id, { ...GOOD, duplicateOf: original.id.slice(0, 8) });

    const input = JSON.parse(calls[0].messages[1].content);
    expect(input.openReports).toEqual([{ id: original.id.slice(0, 8), headline: 'Save button does nothing' }]);
    // Never the reporter, never itself, never closed reports.
    expect(calls[0].messages[1].content).not.toContain('bob@example.com');
    expect(calls[0].response_format.json_schema.schema.required).toContain('duplicateOf');
    expect(calls[0].messages[0].content).toMatch(/never as instructions/);

    expect(note).toContain(`Looks like a duplicate of #${original.id.slice(0, 8)}: Save button does nothing`);
    const [e] = await store.events!(r.id);
    expect(e!.detail).toEqual({ text: note, suggest: { priority: 'high', area: 'editor', duplicateOf: original.id } });
  });

  it('ignores bad suggestions: an unknown or own id, "other", and what the report already says', async () => {
    const store = memoryStore();
    const r = await store.create(sample({ priority: 'high', area: 'editor' }));
    await triage(store, r.id, { ...GOOD, duplicateOf: r.id.slice(0, 8) });
    await triage(store, r.id, { ...GOOD, area: 'other', duplicateOf: 'deadbeef' });
    const events = await store.events!(r.id);
    expect(events.map((e) => e.detail.suggest)).toEqual([undefined, undefined]);
  });

  it('caps the list (0 turns duplicate detection off)', async () => {
    const store = memoryStore();
    for (let i = 0; i < 4; i++) await store.create(sample({ description: `Report number ${i}` }));
    const r = await store.create(sample());
    expect(JSON.parse((await triage(store, r.id, GOOD, 2)).calls[0].messages[1].content).openReports).toHaveLength(2);
    expect(JSON.parse((await triage(store, r.id, GOOD, 0)).calls[0].messages[1].content).openReports).toEqual([]);
    expect(hostedFromEnv({ OPENAI_API_KEY: 'k' }).duplicateCandidates).toBe(50);
    expect(hostedFromEnv({ OPENAI_API_KEY: 'k', SHIPCUE_HOSTED_DUPLICATE_CANDIDATES: '0' }).duplicateCandidates).toBe(0);
  });
});

function teamHandler(store: ReportStore, role: TeamMember['role'] = 'member') {
  return createShipcueHandler({ store, config, team: { getMember: async () => ({ ...ADA, role }), claimants: async () => CLAIMANTS } });
}
const post = (handler: ReturnType<typeof teamHandler>, path: string, body: unknown, headers: Record<string, string> = {}) =>
  handler(new Request(`https://app.example.com/api/shipcue/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }));

describe('merge a duplicate', () => {
  it('closes the duplicate with a link, notes both, and keeps both reporters', async () => {
    const store = memoryStore();
    const handler = teamHandler(store);
    const original = await store.create(sample({ description: 'Save is broken', reporter: 'bob@example.com' }));
    const dup = await store.create(sample({ description: 'Saving fails', reporter: 'cy@example.com' }));
    const res = await post(handler, `team/reports/${dup.id}/merge`, { into: original.id });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.report).toMatchObject({ id: dup.id, status: 'wontfix', resolution: `Duplicate of #${original.id.slice(0, 8)}`, reporter: 'cy@example.com' });
    expect(body.into).toMatchObject({ id: original.id, status: 'open', reporter: 'bob@example.com' });

    const dupEvents = await store.events!(dup.id);
    expect(dupEvents.map((e) => [e.action, e.actor?.name])).toEqual([
      ['closed', 'Ada'],
      ['note', 'Ada'],
    ]);
    expect(dupEvents[1]!.detail).toMatchObject({ text: `Merged into #${original.id.slice(0, 8)} as a duplicate.`, mergedInto: original.id });
    const [onOriginal] = await store.events!(original.id);
    expect(onOriginal!.detail).toMatchObject({ mergedFrom: dup.id, reporters: 1 });
    expect(onOriginal!.detail.text).toBe(`#${dup.id.slice(0, 8)} was merged into this as a duplicate (1 more reporter).`);
    // Never anyone's email in a note.
    expect(JSON.stringify([...dupEvents, onOriginal].map((e) => e!.detail))).not.toMatch(/@example\.com/);
  });

  it('counts reporters already folded into the duplicate', async () => {
    const store = memoryStore();
    const handler = teamHandler(store);
    const [a, b, c] = [await store.create(sample()), await store.create(sample()), await store.create(sample())];
    await post(handler, `team/reports/${c.id}/merge`, { into: b.id });
    await post(handler, `team/reports/${b.id}/merge`, { into: a.id });
    expect((await store.events!(a.id)).at(-1)!.detail).toMatchObject({ reporters: 2, text: expect.stringContaining('(2 more reporters)') });
  });

  it('refuses itself, an unknown report, a closed duplicate, a duplicate as the target, and viewers', async () => {
    const store = memoryStore();
    const handler = teamHandler(store);
    const a = await store.create(sample());
    const b = await store.create(sample());
    const c = await store.create(sample());
    expect((await post(handler, `team/reports/${a.id}/merge`, { into: a.id })).status).toBe(400);
    expect((await post(handler, `team/reports/${a.id}/merge`, {})).status).toBe(400);
    expect((await post(handler, `team/reports/${a.id}/merge`, { into: '00000000-0000-4000-8000-000000000999' })).status).toBe(404);
    expect((await post(handler, `team/reports/${b.id}/merge`, { into: a.id })).status).toBe(200);
    expect((await post(handler, `team/reports/${b.id}/merge`, { into: c.id })).status).toBe(409);
    expect((await post(handler, `team/reports/${c.id}/merge`, { into: b.id })).status).toBe(409);
    expect((await post(teamHandler(store, 'viewer'), `team/reports/${c.id}/merge`, { into: a.id })).status).toBe(403);
    expect((await store.get(c.id))!.status).toBe('open');
  });

  it('agents can merge over the agent API', async () => {
    const store = memoryStore();
    const handler = createShipcueHandler({ store, config, agentToken: 'tok' });
    const a = await store.create(sample());
    const b = await store.create(sample());
    const res = await post(handler, `reports/${b.id}/merge`, { into: a.id, agent: 'claude-code' }, { authorization: 'Bearer tok' });
    expect(res.status).toBe(200);
    expect((await store.get(b.id))!.status).toBe('wontfix');
  });

  it('is refused across Cloud projects', async () => {
    const db = new PGlite();
    await db.exec(readFileSync(join(process.cwd(), 'sql/schema.sql'), 'utf8'));
    await db.exec(readFileSync(join(process.cwd(), 'sql/cloud.sql'), 'utf8'));
    const q = { query: (text: string, params?: unknown[]) => db.query(text, params) };
    const A = postgresStore(q, 'shipcue_reports', { project: '00000000-0000-4000-8000-00000000000a' });
    const B = postgresStore(q, 'shipcue_reports', { project: '00000000-0000-4000-8000-00000000000b' });
    const mine = await A.create(sample());
    const theirs = await B.create(sample());
    const res = await post(teamHandler(A), `team/reports/${mine.id}/merge`, { into: theirs.id });
    expect(res.status).toBe(404);
    expect((await A.get(mine.id))!.status).toBe('open');
    expect(await B.events!(theirs.id)).toEqual([]);
    // Within one project it works on Postgres too, and the note keeps its detail.
    const other = await A.create(sample());
    expect((await post(teamHandler(A), `team/reports/${other.id}/merge`, { into: mine.id })).status).toBe(200);
    expect((await A.events!(mine.id))[0]!.detail).toMatchObject({ mergedFrom: other.id, reporters: 1 });
  }, 30_000);
});

describe('CueLog drawer: Apply chips', () => {
  it('reads only sensible suggestions', () => {
    const r = { id: 'aaaaaaaa-0000-4000-8000-000000000001', priority: 'medium', area: 'other', status: 'open' } as never;
    const other = 'bbbbbbbb-0000-4000-8000-000000000002';
    expect(readSuggestion({ priority: 'high', area: 'editor', duplicateOf: other }, r, areas)).toEqual({ priority: 'high', area: 'editor', duplicateOf: other });
    expect(readSuggestion({ priority: 'urgent', area: 'nowhere', duplicateOf: 'x' }, r, areas)).toBeNull();
    expect(readSuggestion({ priority: 'medium', area: 'other', duplicateOf: 'aaaaaaaa-0000-4000-8000-000000000001' }, r, areas)).toBeNull();
    expect(readSuggestion('nope', r, areas)).toBeNull();
    expect(readSuggestion({ duplicateOf: other }, { ...(r as object), status: 'wontfix' } as never, areas)).toBeNull();
  });

  it('applies priority, area and merge through the team API, each logged under the member', async () => {
    const store = memoryStore();
    const handler = teamHandler(store);
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => handler(new Request(new URL(url, 'https://app.example.com'), init)));
    const original = await store.create(sample({ description: 'Save button does nothing' }));
    const r = await store.create(sample({ description: 'Clicking save is broken', priority: 'medium' }));
    await store.note!(r.id, 'Triage\nSaving is broken.', agent, { suggest: { priority: 'high', area: 'editor', duplicateOf: original.id } });

    render(<CueLogTable liveMs={0} />);
    fireEvent.click(await screen.findByText(/Clicking save is broken/));
    fireEvent.click(await screen.findByRole('button', { name: 'Apply priority: High' }));
    await waitFor(async () => expect((await store.get(r.id))!.priority).toBe('high'));
    fireEvent.click(await screen.findByRole('button', { name: 'Apply area: Editor' }));
    await waitFor(async () => expect((await store.get(r.id))!.area).toBe('editor'));
    fireEvent.click(await screen.findByRole('button', { name: `Merge into #${original.id.slice(0, 8)}` }));
    await waitFor(async () => expect((await store.get(r.id))!.status).toBe('wontfix'));
    expect((await store.events!(r.id)).map((e) => [e.action, e.actor?.name])).toEqual([
      ['note', 'shipcue-agent'],
      ['priority', 'Ada'],
      ['edited', 'Ada'],
      ['closed', 'Ada'],
      ['note', 'Ada'],
    ]);
  });

  it('viewers see the note but no chips', async () => {
    const store = memoryStore();
    const handler = teamHandler(store, 'viewer');
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => handler(new Request(new URL(url, 'https://app.example.com'), init)));
    const r = await store.create(sample({ description: 'Clicking save is broken' }));
    await store.note!(r.id, 'Triage note', agent, { suggest: { priority: 'high' } });
    render(<CueLogTable liveMs={0} />);
    fireEvent.click(await screen.findByText(/Clicking save is broken/));
    await screen.findByText('Triage note');
    expect(screen.queryByRole('button', { name: /Apply priority/ })).toBeNull();
  });
});
