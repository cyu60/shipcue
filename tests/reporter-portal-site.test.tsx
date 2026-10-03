// @vitest-environment jsdom
// shipcue's own My reports page (website/_src/mine.jsx, report 3d0d7995), with a fake session.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
// @ts-expect-error -- plain JS module for the site's page
import { MyReports } from '../website/_src/mine.jsx';
import { createShipcueHandler, memoryStore } from '../src/server';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The site's handler shape (api.mjs): reporterPortal on, the reporter from the session cookie. */
async function site() {
  const store = memoryStore();
  const base = { priority: 'medium' as const, area: 'other', pageUrl: '', userAgent: '', diagnostics: { secret: 'diag-xyz' }, screenshots: [] as string[], context: null };
  const fixed = await store.create({ ...base, type: 'bug', description: 'The CueLog tab forgets itself', reporter: 'ada@example.com' });
  await store.close(fixed.id, 'fixed', 'The tab is kept in the URL now', { prUrl: 'https://github.com/cyu60/shipcue/pull/12' });
  const wont = await store.create({ ...base, type: 'feature', description: 'Make it purple', reporter: 'ada@example.com' });
  await store.close(wont.id, 'wontfix', null);
  await store.create({ ...base, type: 'bug', description: "Bob's private report", reporter: 'bob@example.com' });
  const handle = createShipcueHandler({
    store,
    basePath: '/api/shipcue',
    reporterPortal: true,
    getReporter: async (req) => /(?:^|;\s*)session=([^;]+)/.exec(req.headers.get('cookie') ?? '')?.[1] ?? null,
  });
  return { handle, fixed, wont };
}

const browserAs = (handle: (r: Request) => Promise<Response>, user: string | null) =>
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) =>
    handle(new Request(new URL(url, 'https://shipcue.example.com'), { ...init, headers: user ? { cookie: `session=${user}` } : {} })),
  );

describe('My reports page', () => {
  it("lists the signed-in account's reports with status, fix line, PR and a CueLog link; nobody else's", async () => {
    const { handle, fixed, wont } = await site();
    browserAs(handle, 'ada@example.com');
    render(<MyReports />);
    const list = await screen.findByRole('list', { name: 'My reports' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(within(list).getByText('The CueLog tab forgets itself')).toBeInTheDocument();
    expect(within(list).getByText('The tab is kept in the URL now')).toBeInTheDocument();
    expect(within(list).getByText('Fixed')).toBeInTheDocument();
    expect(within(list).getByText("Won't fix")).toBeInTheDocument();
    expect(within(list).getByRole('link', { name: 'PR #12 ↗' }).getAttribute('href')).toBe('https://github.com/cyu60/shipcue/pull/12');
    const links = within(list).getAllByRole('link', { name: 'On the CueLog' });
    expect(links.map((a) => a.getAttribute('href'))).toEqual([`/cuelog/?view=all#shipcue-${fixed.id}`]);
    expect(document.body.textContent).not.toContain("Bob's private report");
    expect(document.body.textContent).not.toContain('diag-xyz');
    expect(document.body.textContent).not.toContain(wont.id);
  });

  it('asks signed-out people to sign in, and comes back here after', async () => {
    const { handle } = await site();
    browserAs(handle, null);
    render(<MyReports />);
    const link = await screen.findByRole('link', { name: 'Sign in' });
    expect(link.getAttribute('href')).toBe('/app/?next=%2Fapp%2Fmine%2F');
  });
});
