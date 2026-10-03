// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { CueLogTable, filterReports, sortReports } from '../src/react';
import { createShipcueHandler, memoryStore, type TeamMember } from '../src/server';
import type { Claimant, Report } from '../src/core';
import { sample } from './store.contract';

afterEach(cleanup);

const ADA: TeamMember = { id: 'ada@example.com', name: 'Ada', role: 'member' };
const CLAIMANTS: Claimant[] = [
  { kind: 'person', id: 'ada@example.com', name: 'Ada' },
  { kind: 'agent', id: 'agent-1', name: 'claude-code' },
];

async function mount(role: TeamMember['role'] = 'member') {
  const store = memoryStore();
  const handler = createShipcueHandler({ store, team: { getMember: async () => ({ ...ADA, role }), claimants: async () => CLAIMANTS } });
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => handler(new Request(new URL(url, 'https://app.example.com'), init)));
  const bug = await store.create(sample({ description: 'Save button does nothing', priority: 'high' }));
  const idea = await store.create(sample({ type: 'feature', description: 'Dark mode please', priority: 'low' }));
  render(<CueLogTable liveMs={0} />);
  await screen.findByText(/Save button does nothing/);
  return { store, bug, idea };
}

describe('CueLogTable', () => {
  it('lists open reports with nobody on them yet', async () => {
    await mount();
    expect(screen.getByText(/Dark mode please/)).toBeInTheDocument();
    expect(screen.getAllByRole('combobox', { name: 'Claimed by' }).filter((el) => (el as HTMLSelectElement).value === '').length).toBeGreaterThanOrEqual(2);
  });

  it('assigns a report to an agent from its row', async () => {
    const { store, bug } = await mount();
    const row = screen.getByText(/Save button does nothing/).closest('tr')!;
    const select = row.querySelector('select[aria-label="Claimed by"]') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'agent:agent-1' } });
    await waitFor(async () => expect((await store.get(bug.id))?.claimantId).toBe('agent-1'));
    await screen.findByText('queued for');
  });

  it('a viewer gets no controls', async () => {
    await mount('viewer');
    expect(screen.queryByRole('checkbox', { name: 'Select all' })).toBeNull();
    expect(screen.queryAllByRole('combobox', { name: 'Claimed by' }).filter((el) => el.tagName === 'SELECT' && !(el as HTMLSelectElement).disabled && el.closest('tbody'))).toHaveLength(0);
  });

  it('opens the drawer and claims it', async () => {
    const { store, bug } = await mount();
    fireEvent.click(screen.getByText(/Save button does nothing/));
    fireEvent.click(await screen.findByRole('button', { name: 'Claim' }));
    await waitFor(async () => expect((await store.get(bug.id))?.claimedBy).toBe('Ada'));
    await screen.findByText(/Ada claimed it/);
  });
});

describe('filters and sorting', () => {
  const r = (over: Partial<Report>): Report => ({
    ...sample(),
    id: Math.random().toString(),
    status: 'open',
    createdAt: '2026-10-01T00:00:00Z',
    claimedBy: null,
    claimedAt: null,
    resolution: null,
    video: null,
    context: null,
    ...over,
  });
  it('keeps mine, unclaimed and agents apart', () => {
    const list = [r({ claimantId: 'me', claimantKind: 'person', status: 'claimed' }), r({}), r({ claimantId: 'a1', claimantKind: 'agent', status: 'claimed' }), r({ status: 'fixed', claimantId: 'me' })];
    expect(filterReports(list, { tab: 'mine' }, 'me')).toHaveLength(1);
    expect(filterReports(list, { tab: 'open', claimant: 'none' }, 'me')).toHaveLength(1);
    expect(filterReports(list, { tab: 'all', claimant: 'agents' }, 'me')).toHaveLength(1);
    expect(filterReports(list, { tab: 'fixed' }, 'me')).toHaveLength(1);
  });
  it('sorts by longest waiting', () => {
    const old = r({ createdAt: '2026-09-01T00:00:00Z' });
    expect(sortReports([r({}), old], 'waiting')[0]).toBe(old);
  });
});
