// @vitest-environment jsdom
// The CueLog and the board, with what Habitect's /reports page grew (shipcue report 5c54da74):
// edit a filed report, rewrite what changed, links to a report and a tab, keys, PR links in the
// table, Context drawn as an outline, a lighter list, and search, type and day groups on the board.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { CueLogTable, ShipcueBoard } from '../src/react';
import { createShipcueHandler, memoryStore, type TeamMember } from '../src/server';
import { resolveConfig, type Claimant } from '../src/core';
import { sample } from './store.contract';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

const ADA: TeamMember = { id: 'ada@example.com', name: 'Ada', role: 'member' };
const CLAIMANTS: Claimant[] = [{ kind: 'person', id: 'ada@example.com', name: 'Ada' }];
const config = resolveConfig({ areas: [{ value: 'editor', label: 'Editor' }] });

function handlerFor(store = memoryStore(), role: TeamMember['role'] = 'member') {
  const handler = createShipcueHandler({ store, config, team: { getMember: async () => ({ ...ADA, role }), claimants: async () => CLAIMANTS } });
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => handler(new Request(new URL(url, 'https://app.example.com'), init)));
  return handler;
}
const post = (handler: ReturnType<typeof handlerFor>, path: string, body: unknown) =>
  handler(new Request(`https://app.example.com/api/shipcue/team/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
const get = (handler: ReturnType<typeof handlerFor>, path: string) => handler(new Request(`https://app.example.com/api/shipcue/team/${path}`));

async function mount(role: TeamMember['role'] = 'member', props: Parameters<typeof CueLogTable>[0] = {}) {
  const store = memoryStore();
  handlerFor(store, role);
  const bug = await store.create(sample({ description: 'Save button does nothing', priority: 'high', diagnostics: { big: 'x'.repeat(50) } }));
  const idea = await store.create(sample({ type: 'feature', description: 'Dark mode please', priority: 'low', context: '- Settings\n  - Theme' }));
  render(<CueLogTable liveMs={0} {...props} />);
  await screen.findByText(/Save button does nothing/);
  return { store, bug, idea };
}

describe('team API: edit', () => {
  it('a member edits the text, type and area; the history says so', async () => {
    const store = memoryStore();
    const handler = handlerFor(store);
    const r = await store.create(sample());
    const res = await post(handler, `reports/${r.id}/edit`, { description: 'Saving fails on Safari', type: 'feature', area: 'editor' });
    expect(res.status).toBe(200);
    expect((await res.json()).report).toMatchObject({ description: 'Saving fails on Safari', type: 'feature', area: 'editor' });
    expect((await store.events!(r.id)).map((e) => e.action)).toEqual(['edited']);
  });

  it('checks the edit against the config, and needs something to change', async () => {
    const store = memoryStore();
    const handler = handlerFor(store);
    const r = await store.create(sample());
    expect((await post(handler, `reports/${r.id}/edit`, { description: 'short' })).status).toBe(400);
    expect((await post(handler, `reports/${r.id}/edit`, { area: 'nowhere' })).status).toBe(400);
    expect((await post(handler, `reports/${r.id}/edit`, { type: 'nope' })).status).toBe(400);
    expect((await post(handler, `reports/${r.id}/edit`, {})).status).toBe(400);
    expect((await post(handler, `reports/00000000-0000-4000-8000-000000000999/edit`, { description: 'A long enough text' })).status).toBe(404);
  });

  it('a viewer cannot edit', async () => {
    const store = memoryStore();
    const handler = handlerFor(store, 'viewer');
    const r = await store.create(sample());
    expect((await post(handler, `reports/${r.id}/edit`, { description: 'Saving fails on Safari' })).status).toBe(403);
  });

  it('the list leaves out diagnostics; one report has them; /me says the areas', async () => {
    const store = memoryStore();
    const handler = handlerFor(store);
    const r = await store.create(sample({ diagnostics: { big: 1 } }));
    const list = (await (await get(handler, 'reports')).json()).reports;
    expect(list[0]).not.toHaveProperty('diagnostics');
    expect((await (await get(handler, `reports/${r.id}`)).json()).report.diagnostics).toEqual({ big: 1 });
    expect((await (await get(handler, 'me')).json()).areas).toEqual(config.areas);
  });
});

describe('CueLogTable', () => {
  it('edits a report from the drawer, and the row shows it at once', async () => {
    const { store, bug } = await mount();
    fireEvent.click(screen.getByText(/Save button does nothing/));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const box = screen.getByRole('textbox', { name: 'Report text' });
    fireEvent.change(box, { target: { value: 'Save button does nothing on Safari' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Area' }), { target: { value: 'editor' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(async () => expect((await store.get(bug.id))?.description).toBe('Save button does nothing on Safari'));
    expect((await store.get(bug.id))?.area).toBe('editor');
    expect((await screen.findAllByText(/on Safari/)).length).toBeGreaterThan(0);
    await screen.findByText(/Ada edited it/);
  });

  it('Esc in the edit form cancels the edit, not the drawer', async () => {
    await mount();
    fireEvent.click(screen.getByText(/Save button does nothing/));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Report text' }), { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'Report text' })).toBeNull();
    expect(screen.getByRole('complementary', { name: 'Report' })).toBeInTheDocument();
  });

  it("rewrites a closed report's what-changed line", async () => {
    const { store, bug } = await mount();
    await store.close(bug.id, 'fixed', 'First go');
    fireEvent.click(screen.getByRole('tab', { name: /Fixed/ }));
    await waitFor(() => expect(screen.queryByText(/Save button does nothing/)).toBeNull());
    // The table reads the change on its next load; open the Fixed tab after a reload.
    cleanup();
    render(<CueLogTable liveMs={0} initialTab="fixed" />);
    fireEvent.click(await screen.findByText(/Save button does nothing/));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'What changed' }), { target: { value: 'Saving works on Safari' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(async () => expect((await store.get(bug.id))?.resolution).toBe('Saving works on Safari'));
    expect((await store.get(bug.id))?.status).toBe('fixed');
  });

  it('a viewer gets no Edit', async () => {
    await mount('viewer');
    fireEvent.click(screen.getByText(/Save button does nothing/));
    await screen.findByText(/Filed/);
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('with syncUrl, keeps the tab and the open report in the URL, and opens from it', async () => {
    const { idea } = await mount('member', { syncUrl: true });
    fireEvent.click(screen.getByRole('tab', { name: /All/ }));
    expect(new URL(window.location.href).searchParams.get('tab')).toBe('all');
    fireEvent.click(screen.getByText(/Dark mode please/));
    expect(new URL(window.location.href).searchParams.get('report')).toBe(idea.id);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(new URL(window.location.href).searchParams.get('report')).toBeNull();

    cleanup();
    window.history.replaceState(null, '', `/admin?tab=all&report=${idea.id}`);
    render(<CueLogTable liveMs={0} syncUrl />);
    const drawer = await screen.findByRole('complementary', { name: 'Report' });
    expect(within(drawer).getByText('Dark mode please')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /All/ }).getAttribute('aria-selected')).toBe('true');
  });

  it('by default leaves the URL alone, has no keys and no Copy link', async () => {
    await mount();
    fireEvent.click(screen.getByRole('tab', { name: /All/ }));
    expect(window.location.search).toBe('');
    expect(screen.queryByText(/j k move/)).toBeNull();
    fireEvent.keyDown(document.body, { key: '/' });
    expect(document.activeElement).not.toBe(screen.getByRole('searchbox', { name: 'Search' }));
    fireEvent.click(screen.getByText(/Dark mode please/));
    await screen.findByRole('complementary', { name: 'Report' });
    expect(screen.queryByRole('button', { name: 'Copy link' })).toBeNull();
  });

  it('copies a link to the report', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { bug } = await mount('member', { syncUrl: true });
    fireEvent.click(screen.getByText(/Save button does nothing/));
    fireEvent.click(await screen.findByRole('button', { name: 'Copy link' }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining(`report=${bug.id}`));
  });

  it('keys: / searches, j and k move, Enter opens, p pins', async () => {
    localStorage.clear();
    await mount('member', { hotkeys: true });
    fireEvent.keyDown(document.body, { key: '/' });
    expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'Search' }));
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(document.body, { key: 'j' });
    fireEvent.keyDown(document.body, { key: 'j' });
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows[1]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(document.body, { key: 'k' });
    expect(rows[0]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(document.body, { key: 'p' });
    expect(JSON.parse(localStorage.getItem('shipcue:stars')!)).toHaveLength(1);
    fireEvent.keyDown(document.body, { key: 'Enter' });
    expect(await screen.findByRole('complementary', { name: 'Report' })).toBeInTheDocument();
    expect(screen.getByText(/j k move/)).toBeInTheDocument();
  });

  it("shows the PR on the report's row", async () => {
    const { store, bug } = await mount();
    await store.review!(bug.id, 'https://github.com/acme/app/pull/42');
    cleanup();
    render(<CueLogTable liveMs={0} initialTab="all" />);
    const link = await screen.findByRole('link', { name: /PR #42/ });
    expect(link.getAttribute('href')).toBe('https://github.com/acme/app/pull/42');
  });

  it('draws an outline Context, with a Raw switch', async () => {
    await mount();
    fireEvent.click(screen.getByText(/Dark mode please/));
    fireEvent.click(await screen.findByText('Context'));
    expect(screen.getByText('Theme')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Raw' }));
    expect(screen.getByText(/- Settings/)).toBeInTheDocument();
  });

  it('reads the diagnostics with the report, not the list', async () => {
    await mount();
    fireEvent.click(screen.getByText(/Save button does nothing/));
    expect(await screen.findByText('App snapshot')).toBeInTheDocument();
  });
});

const item = (id: string, extra: Record<string, unknown> = {}) => ({
  id, type: 'feature', priority: 'medium', area: 'other', description: `asked ${id}`, status: 'open',
  resolution: null, createdAt: '2026-10-02T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', ...extra,
});

describe('ShipcueBoard', () => {
  beforeEach(() => localStorage.clear());
  const serve = (board: unknown) => vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(board)));

  it('searches and narrows by type', async () => {
    serve({ queue: [item('q1', { description: 'Dark mode please' }), item('q2', { type: 'bug', description: 'Save fails' })], changelog: [] });
    render(<ShipcueBoard refreshMs={0} liveMs={0} filters />);
    await screen.findByText('Dark mode please');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), { target: { value: 'save' } });
    expect(screen.queryByText('Dark mode please')).toBeNull();
    expect(screen.getByText('Save fails')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), { target: { value: '' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Type' }), { target: { value: 'feature' } });
    expect(screen.getByText('Dark mode please')).toBeInTheDocument();
    expect(screen.queryByText('Save fails')).toBeNull();
    expect(screen.getByRole('tab', { name: 'Open 1' })).toBeInTheDocument();
  });

  it('has no type picker when there is one type, and no filters unless asked', async () => {
    serve({ queue: [item('q1')], changelog: [] });
    const { unmount } = render(<ShipcueBoard refreshMs={0} liveMs={0} filters />);
    await screen.findByText('asked q1');
    expect(screen.queryByRole('combobox', { name: 'Type' })).toBeNull();
    unmount();
    render(<ShipcueBoard refreshMs={0} liveMs={0} />);
    await screen.findByText('asked q1');
    expect(screen.queryByRole('searchbox', { name: 'Search' })).toBeNull();
  });

  it('groups the changelog by the day it shipped', async () => {
    serve({
      queue: [],
      changelog: [
        item('c1', { status: 'fixed', resolution: 'Shipped c1', updatedAt: '2026-10-03T15:00:00Z' }),
        item('c2', { status: 'fixed', resolution: 'Shipped c2', updatedAt: '2026-10-03T12:00:00Z' }),
        item('c3', { status: 'fixed', resolution: 'Shipped c3', updatedAt: '2026-09-20T12:00:00Z' }),
      ],
    });
    render(<ShipcueBoard refreshMs={0} liveMs={0} initialView="changelog" />);
    await screen.findByText('Shipped c1');
    const days = screen.getAllByRole('heading', { level: 3 });
    expect(days).toHaveLength(2);
    expect(days[0]!.textContent).toMatch(/Oct/);
    expect(days[0]!.textContent).toMatch(/\b3\b/);
    expect(days[1]!.textContent).toMatch(/Sep/);
  });

  it('keeps the tab in the URL and opens on it', async () => {
    serve({ queue: [item('q1')], changelog: [item('c1', { status: 'fixed', resolution: 'Shipped c1' })] });
    const { unmount } = render(<ShipcueBoard refreshMs={0} liveMs={0} syncUrl />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Changelog' }));
    expect(new URL(window.location.href).searchParams.get('view')).toBe('changelog');
    unmount();
    render(<ShipcueBoard refreshMs={0} liveMs={0} syncUrl />);
    expect((await screen.findByRole('tab', { name: 'Changelog' })).getAttribute('aria-selected')).toBe('true');
  });
});
