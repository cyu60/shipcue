// @vitest-environment jsdom
// The CueLog's "overlaps #id8" badge (shipcue report 83f5d976, docs/swarm.md).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { CueLogTable } from '../src/react';
import { createShipcueHandler, memoryStore, type TeamMember } from '../src/server';
import { sample } from './store.contract';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

const ADA: TeamMember = { id: 'ada@example.com', name: 'Ada', role: 'member' };
const bot = (id: string) => ({ kind: 'agent' as const, id, name: id });

describe('CueLog overlap badge', () => {
  it('marks each of two overlapping claims with the other one, and leaves the rest alone', async () => {
    const store = memoryStore();
    const handler = createShipcueHandler({ store, team: { getMember: async () => ADA } });
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => handler(new Request(new URL(url, 'https://app.example.com'), init)));
    const a = await store.create(sample({ description: 'Alpha sync bug' }));
    const b = await store.create(sample({ description: 'Beta sync bug' }));
    const c = await store.create(sample({ description: 'Gamma docs' }));
    await store.claim(a.id, bot('one'), { scope: { paths: ['src/sync/**'] } });
    await store.claim(b.id, bot('two'), { scope: { paths: ['src/sync/merge.ts'] } });
    await store.claim(c.id, bot('three'), { scope: { paths: ['docs/**'] } });
    render(<CueLogTable liveMs={0} initialTab="all" />);
    const badgeA = await screen.findByText(`overlaps #${b.id.slice(0, 8)}`);
    expect(badgeA.closest('tr')!.textContent).toContain('Alpha sync bug');
    expect(badgeA.getAttribute('title')).toContain('src/sync/merge.ts');
    expect(screen.getByText(`overlaps #${a.id.slice(0, 8)}`).closest('tr')!.textContent).toContain('Beta sync bug');
    expect(screen.getByText(/Gamma docs/).closest('tr')!.textContent).not.toContain('overlaps');
  });

  it('an older handler without team/conflicts just shows no badges', async () => {
    const store = memoryStore();
    const handler = createShipcueHandler({ store, team: { getMember: async () => ADA } });
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) =>
      String(url).includes('/team/conflicts') ? Promise.resolve(new Response('{"error":"Not found"}', { status: 404 })) : handler(new Request(new URL(url, 'https://app.example.com'), init)),
    );
    await store.create(sample({ description: 'Lonely report' }));
    render(<CueLogTable liveMs={0} />);
    await screen.findByText(/Lonely report/);
    expect(screen.queryByText(/overlaps #/)).toBeNull();
  });
});
