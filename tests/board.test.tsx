// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ShipcueBoard } from '../src/react';

const item = (id: string, extra: Record<string, unknown> = {}) => ({
  id, type: 'feature', priority: 'medium', area: 'other', description: `asked ${id}`, status: 'open',
  resolution: null, createdAt: '2026-10-02T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', ...extra,
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ShipcueBoard', () => {
  it('has Open / Fixed / All / Changelog tabs, and shows screenshots', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        queue: [item('q1', { screenshots: ['/api/shipcue/board/screenshot/q1/0'] })],
        changelog: [item('c1', { status: 'fixed', resolution: 'Shipped c1' })],
      })),
    );
    render(<ShipcueBoard refreshMs={0} />);
    const open = await screen.findByRole('tab', { name: 'Open 1' });
    expect(open.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Fixed 1' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'All 2' })).toBeTruthy();
    expect(screen.getByAltText('Screenshot 1').getAttribute('src')).toBe('/api/shipcue/board/screenshot/q1/0');
    expect(screen.queryByText('asked c1')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'All 2' }));
    expect(screen.getByText('asked q1')).toBeTruthy();
    expect(screen.getByText('asked c1')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Changelog' }));
    expect(screen.getByText('Shipped c1')).toBeTruthy();
    expect(screen.queryByAltText('Screenshot 1')).toBeNull();
  });

  it("lets each viewer pick tabs or pills and cards or a list, and keeps the pick", async () => {
    localStorage.clear();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ queue: [item('q1', { screenshots: ['/x/0'] })], changelog: [] })),
    );
    const { unmount } = render(<ShipcueBoard refreshMs={0} />);
    await screen.findByRole('tab', { name: 'Open 1' });
    expect(screen.getByRole('radio', { name: 'Pills' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: 'Tabs' }));
    fireEvent.click(screen.getByRole('radio', { name: 'List' }));
    expect(screen.queryByAltText('Screenshot 1')).toBeNull(); // the list is one line per report
    expect(JSON.parse(localStorage.getItem('shipcue:board-view')!)).toEqual({ tabStyle: 'tabs', layout: 'list' });
    unmount();
    render(<ShipcueBoard refreshMs={0} />);
    await screen.findByRole('tab', { name: 'Open 1' });
    expect(screen.getByRole('radio', { name: 'Tabs' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: 'List' }).getAttribute('aria-checked')).toBe('true');
  });

  it('takes the app default and can hide the picker', async () => {
    localStorage.clear();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ queue: [item('q1')], changelog: [] })));
    render(<ShipcueBoard refreshMs={0} tabStyle="tabs" viewPicker={false} />);
    await screen.findByRole('tab', { name: 'Open 1' });
    expect(screen.queryByRole('radio', { name: 'Pills' })).toBeNull();
  });
});
