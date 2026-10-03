// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { Lightbox, ShipcueBoard, ReportButton } from '../src/react';
import { starredFirst } from '../src/react/stars';
import type { Board } from '../src/core';

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Lightbox (outliner report eea8e2be)', () => {
  it('shows the image on the page, zooms on click, moves with arrows and closes with Esc', () => {
    const onClose = vi.fn();
    render(<Lightbox images={['/a.png', '/b.png']} index={0} onClose={onClose} />);
    const dialog = screen.getByRole('dialog', { name: 'Screenshot 1 of 2' });
    const img = within(dialog).getByRole('img');
    expect(img.getAttribute('src')).toBe('/a.png');
    fireEvent.click(img);
    expect(img.style.cursor).toBe('zoom-out');
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(within(dialog).getByRole('img').getAttribute('src')).toBe('/b.png');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});

const board: Board = {
  queue: [
    { id: 'q1', type: 'bug', priority: 'medium', area: 'other', description: 'First one', status: 'open', resolution: null, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', screenshots: ['/s1.png'] },
    { id: 'q2', type: 'feature', priority: 'medium', area: 'other', description: 'Second one', status: 'open', resolution: null, createdAt: '2026-10-02T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z' },
  ],
  changelog: [],
};

describe('stars on the CueLog board (report 013562b6)', () => {
  it('a star pins a report to the top and adds a Starred tab; screenshots open in place', async () => {
    vi.stubGlobal('fetch', async (url: string) => new Response(JSON.stringify(url.endsWith('/version') ? { version: '1' } : board)));
    localStorage.setItem('shipcue:mine', JSON.stringify([{ id: 'q2', type: 'feature', title: 'Second one', at: '2026-10-02T00:00:00Z' }]));
    render(<ShipcueBoard liveMs={0} refreshMs={0} />);
    await screen.findByText('First one');
    expect(screen.getByText('Yours')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pin: Second one' }));
    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Second one');
    expect(screen.getByRole('tab', { name: 'Pinned 1' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Preview screenshot 1' }));
    expect(screen.getByRole('dialog', { name: 'Screenshot 1 of 1' })).toBeInTheDocument();
  });

  it('starredFirst keeps the rest in order', () => {
    expect(starredFirst([{ id: 'a' }, { id: 'b' }, { id: 'c' }], ['c']).map((x) => x.id)).toEqual(['c', 'a', 'b']);
  });
});

describe('the report panel remembers what you sent', () => {
  it('lists your reports under Yours, and you can star them', async () => {
    vi.stubGlobal('fetch', async (url: string) =>
      String(url).endsWith('/capabilities') ? new Response('{}', { status: 404 }) : new Response(JSON.stringify({ id: 'r-1' }), { status: 201 }),
    );
    render(<ReportButton endpoint="/api/shipcue" />);
    const fab = screen.getAllByRole('button').find((b) => b.querySelector('[data-icon="hat"]'))!;
    fireEvent.click(fab);
    fireEvent.change(await screen.findByRole('textbox', { name: /what/i }).catch(() => screen.getAllByRole('textbox')[0]!), { target: { value: 'The save button does nothing at all' } });
    fireEvent.click(screen.getByRole('button', { name: /^Send/ }));
    await screen.findByRole('status');
    fireEvent.click(fab);
    fireEvent.click(await screen.findByRole('button', { name: /^Yours/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Pin The save button does nothing at all' }));
    expect(JSON.parse(localStorage.getItem('shipcue:stars')!)).toEqual(['r-1']);
  });
});

describe('the sign-in nudge (report dce33fd0)', () => {
  it('shows a Sign in link when the handler wants one, and offers anonymity once signed in', async () => {
    let signedIn = false;
    let sentAnonymous: string | null = null;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/capabilities')) return new Response(JSON.stringify({ video: null, files: false, maxVideoBytes: 1, maxVideoSeconds: 1, maxScreenshots: 5, maxScreenshotBytes: 1e6, maxTotalScreenshotBytes: 4e6, signedIn, anonymous: true }));
      sentAnonymous = (init?.body as FormData).get('anonymous') as string | null;
      return signedIn ? new Response(JSON.stringify({ id: 'r-2' }), { status: 201 }) : new Response(JSON.stringify({ error: 'You have sent 3 reports without signing in.', signIn: '/app/?next=%2F' }), { status: 401 });
    });
    render(<ReportButton endpoint="/api/shipcue" />);
    const fab = screen.getAllByRole('button').find((b) => b.querySelector('[data-icon="hat"]'))!;
    fireEvent.click(fab);
    fireEvent.change(screen.getAllByRole('textbox')[0]!, { target: { value: 'One more thing that broke here' } });
    fireEvent.click(screen.getByRole('button', { name: /^Send/ }));
    expect((await screen.findByRole('link', { name: 'Sign in' })).getAttribute('href')).toBe('/app/?next=%2F');
    cleanup();
    signedIn = true;
    render(<ReportButton endpoint="/api/shipcue" />);
    fireEvent.click(screen.getAllByRole('button').find((b) => b.querySelector('[data-icon="hat"]'))!);
    fireEvent.click(await screen.findByRole('checkbox', { name: /Send anonymously/ }));
    fireEvent.change(screen.getAllByRole('textbox')[0]!, { target: { value: 'One more thing that broke here' } });
    fireEvent.click(screen.getByRole('button', { name: /^Send/ }));
    await screen.findByRole('status');
    expect(sentAnonymous).toBe('1');
  });
});

describe('the Pin button next to Dictate (report a346d199)', () => {
  it('pins the report as it is sent', async () => {
    vi.stubGlobal('fetch', async (url: string) =>
      String(url).endsWith('/capabilities') ? new Response('{}', { status: 404 }) : new Response(JSON.stringify({ id: 'r-9' }), { status: 201 }),
    );
    render(<ReportButton endpoint="/api/shipcue" />);
    fireEvent.click(screen.getAllByRole('button').find((b) => b.querySelector('[data-icon="hat"]'))!);
    const pin = await screen.findByRole('button', { name: 'Pin this report' });
    expect(pin.querySelector('[data-icon="pin"]')).not.toBeNull();
    fireEvent.click(pin);
    expect(screen.getByRole('button', { name: 'Unpin this report' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.change(screen.getAllByRole('textbox')[0]!, { target: { value: 'Pin this one please, it matters' } });
    fireEvent.click(screen.getByRole('button', { name: /^Send/ }));
    await screen.findByRole('status');
    expect(JSON.parse(localStorage.getItem('shipcue:stars')!)).toEqual(['r-9']);
  });
});

it('pin={false} hides the Pin button, and a pinned send tells the backend', async () => {
  let pinned: string | null = null;
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/capabilities')) return new Response('{}', { status: 404 });
    pinned = (init?.body as FormData).get('pinned') as string | null;
    return new Response(JSON.stringify({ id: 'r-10' }), { status: 201 });
  });
  const { unmount } = render(<ReportButton endpoint="/api/shipcue" pin={false} />);
  fireEvent.click(screen.getAllByRole('button').find((b) => b.querySelector('[data-icon="hat"]'))!);
  expect(screen.queryByRole('button', { name: 'Pin this report' })).toBeNull();
  unmount();
  render(<ReportButton endpoint="/api/shipcue" />);
  fireEvent.click(screen.getAllByRole('button').find((b) => b.querySelector('[data-icon="hat"]'))!);
  fireEvent.click(await screen.findByRole('button', { name: 'Pin this report' }));
  fireEvent.change(screen.getAllByRole('textbox')[0]!, { target: { value: 'Pinned and sent to the backend' } });
  fireEvent.click(screen.getByRole('button', { name: /^Send/ }));
  await screen.findByRole('status');
  expect(pinned).toBe('1');
});
