// @vitest-environment jsdom
// One-click suggestions and duplicate detection (shipcue report 1c0bf5be): the CueLog drawer shows a
// note's structured suggestions (priority, area, "looks like #id") as Apply chips, and Merge folds a
// duplicate into the original.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { PGlite } from '@electric-sql/pglite';
import { CueLogTable, readSuggestion } from '../src/react';
import { createShipcueHandler, memoryStore, postgresStore, type ReportStore, type TeamMember } from '../src/server';
import { resolveConfig, type Claimant } from '../src/core';
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
    await db.exec(readFileSync(join(process.cwd(), 'sql/projects.sql'), 'utf8'));
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
