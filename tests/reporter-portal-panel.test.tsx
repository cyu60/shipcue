// @vitest-environment jsdom
// Yours on any device (shipcue report 3d0d7995): the panel merges the handler's GET /mine with
// this browser's list, one per id, pins kept in this browser.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { ReportButton, ShipcueBoard } from '../src/react';
import { mergeMine, type MyReport } from '../src/react/stars';
import type { MineItem } from '../src/core';

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const caps = (mine?: boolean) => ({ video: null, files: false, maxVideoBytes: 1, maxVideoSeconds: 1, maxScreenshots: 5, maxScreenshotBytes: 1e6, maxTotalScreenshotBytes: 4e6, ...(mine ? { mine } : {}) });
const item = (over: Partial<MineItem>): MineItem => ({ id: 'x', type: 'bug', status: 'open', title: 'T', resolution: null, prUrl: null, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', ...over });

describe('mergeMine', () => {
  it('dedupes by id (the server status wins, the local time stays) and sorts newest first', () => {
    const local: MyReport[] = [
      { id: 'a', type: 'bug', title: 'Local a', at: '2026-10-02T00:00:00Z' },
      { id: 'b', type: 'feature', title: 'Only here', at: '2026-10-01T00:00:00Z' },
    ];
    const merged = mergeMine(local, [item({ id: 'a', title: 'Server a', status: 'fixed', resolution: 'Done', createdAt: '2026-10-02T00:00:05Z' }), item({ id: 'c', title: 'From my phone', createdAt: '2026-10-03T00:00:00Z' })]);
    expect(merged.map((m) => m.id)).toEqual(['c', 'a', 'b']);
    expect(merged[1]).toMatchObject({ title: 'Server a', status: 'fixed', resolution: 'Done', at: '2026-10-02T00:00:00Z' });
    expect(merged[2]!.status).toBeUndefined();
  });
});

function open() {
  render(<ReportButton endpoint="/api/shipcue" />);
  const fab = screen.getAllByRole('button').find((b) => b.querySelector('[data-icon="hat"]'))!;
  fireEvent.click(fab);
}

describe('Yours with the reporter portal', () => {
  it('adds reports filed on other devices, with status and PR, and pins stay local', async () => {
    localStorage.setItem('shipcue:mine', JSON.stringify([{ id: 'a', type: 'bug', title: 'Sent from this laptop', at: '2026-10-02T00:00:00Z' }]));
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(String(url));
      if (String(url).endsWith('/capabilities')) return new Response(JSON.stringify(caps(true)));
      if (String(url).endsWith('/mine'))
        return new Response(JSON.stringify({ reports: [item({ id: 'a', title: 'Sent from this laptop', status: 'claimed' }), item({ id: 'p', title: 'Sent from my phone', status: 'fixed', resolution: 'Works now', prUrl: 'https://github.com/o/r/pull/9', createdAt: '2026-10-03T00:00:00Z' })] }));
      return new Response('{}', { status: 404 });
    });
    open();
    const yours = await screen.findByRole('button', { name: /^Yours/ });
    fireEvent.click(yours);
    const box = await screen.findByLabelText('Your reports');
    await within(box).findByText('Sent from my phone');
    expect(within(box).getAllByText('Sent from this laptop')).toHaveLength(1);
    expect(within(box).getByText('Fixed')).toBeInTheDocument();
    expect(within(box).getByText('In progress')).toBeInTheDocument();
    expect(within(box).getByRole('link', { name: 'PR #9' }).getAttribute('href')).toBe('https://github.com/o/r/pull/9');
    expect(screen.getByRole('button', { name: /^Yours \(2\)/ })).toBeInTheDocument();
    fireEvent.click(within(box).getByRole('button', { name: 'Pin Sent from my phone' }));
    expect(JSON.parse(localStorage.getItem('shipcue:stars')!)).toEqual(['p']);
    expect(calls.filter((u) => u.endsWith('/mine'))).toHaveLength(1);
  });

  it('never asks for /mine when the handler does not offer it', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(String(url));
      return String(url).endsWith('/capabilities') ? new Response(JSON.stringify(caps())) : new Response('{}', { status: 404 });
    });
    open();
    await screen.findByRole('button', { name: /^Yours/ });
    await new Promise((r) => setTimeout(r, 20));
    fireEvent.click(screen.getByRole('button', { name: /^Yours/ }));
    expect(await screen.findByText('Reports you send from this browser show up here.')).toBeInTheDocument();
    expect(calls.some((u) => u.endsWith('/mine'))).toBe(false);
  });
});

describe('a link to one report on the CueLog', () => {
  it('scrolls to #shipcue-<id> once the board is in', async () => {
    const board = { queue: [], changelog: [{ id: 'f1', type: 'bug', priority: 'low', area: 'other', description: 'Was broken', status: 'fixed', resolution: 'Fixed it', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z' }] };
    vi.stubGlobal('fetch', async (url: string) => new Response(JSON.stringify(String(url).endsWith('/version') ? { version: '1' } : board)));
    const scrolled: string[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.id);
    };
    window.history.replaceState(null, '', '/cuelog/?view=all#shipcue-f1');
    render(<ShipcueBoard endpoint="/api/shipcue" syncUrl />);
    await screen.findByText('Was broken');
    expect(document.getElementById('shipcue-f1')).not.toBeNull();
    expect(scrolled).toContain('shipcue-f1');
    window.history.replaceState(null, '', '/');
  });
});
