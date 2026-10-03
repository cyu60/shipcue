// @vitest-environment jsdom
import { it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ShipcueBoard } from '../src/react';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('the changelog links each fix the viewer may see', async () => {
  const board = {
    queue: [],
    changelog: [{ id: 'c1', type: 'bug', priority: 'medium', area: 'other', description: 'It broke', status: 'fixed', resolution: 'Fixed it', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', prUrl: 'https://github.com/o/r/pull/12' }],
  };
  vi.stubGlobal('fetch', async (url: string) => new Response(JSON.stringify(url.endsWith('/version') ? { version: '1' } : board)));
  render(<ShipcueBoard liveMs={0} refreshMs={0} initialView="changelog" />);
  const link = await screen.findByRole('link', { name: /See the fix on GitHub: PR #12/ });
  expect(link.getAttribute('href')).toBe('https://github.com/o/r/pull/12');
});
