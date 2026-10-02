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
  it('toggles between the queue and the changelog, and shows screenshots', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        queue: [item('q1', { screenshots: ['/api/shipcue/board/screenshot/q1/0'] })],
        changelog: [item('c1', { status: 'fixed', resolution: 'Shipped c1' })],
      })),
    );
    render(<ShipcueBoard refreshMs={0} />);
    const queueTab = await screen.findByRole('tab', { name: 'Queue (1)' });
    expect(queueTab.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByAltText('Screenshot 1').getAttribute('src')).toBe('/api/shipcue/board/screenshot/q1/0');
    expect(screen.queryByText('Shipped c1')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Changelog (1)' }));
    expect(screen.getByText('Shipped c1')).toBeTruthy();
    expect(screen.queryByAltText('Screenshot 1')).toBeNull();
  });
});
