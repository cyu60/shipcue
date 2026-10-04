// @vitest-environment jsdom
// Open what you sent from the Yours list, even without a server (shipcue report fec27a48):
// the browser keeps the full report a person sent (never the screenshot or video data), each
// Yours item opens a read-only detail, and LocalReports shows the same from storage alone.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReportButton, LocalReports } from '../src/react';
import { loadMine, rememberMine, MAX_MINE, MAX_MINE_BYTES, MAX_KEPT_TEXT, type MyReport } from '../src/react/stars';
import type { MineItem } from '../src/core';

beforeAll(() => {
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
});
beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const areas = [{ value: 'editor', label: 'Editor' }];
const full = (over: Partial<MyReport> = {}): MyReport => ({
  id: 'r1',
  type: 'bug',
  title: 'Heading disappears on Enter',
  at: '2026-10-03T10:00:00Z',
  description: 'Heading disappears on Enter\nIt happens on every page.',
  priority: 'high',
  area: 'editor',
  areaLabel: 'Editor',
  pageUrl: 'https://app.example.com/notes/1',
  context: '- Parent block\n  - [[Child]] block',
  screenshots: 2,
  files: 1,
  video: true,
  alts: ['The heading before', ''],
  ...over,
});
const openButton = () => screen.getByRole('button', { name: 'Report a bug or request a feature' });

describe('the full report is kept on send', () => {
  it('stores description, type, priority, area, page, context and counts, even through a custom submit', async () => {
    const submit = vi.fn(async (_f: FormData) => ({ id: 'r1' }));
    render(<ReportButton areas={areas} submit={submit} getContext={() => '- picked block'} />);
    await userEvent.click(openButton());
    fireEvent.paste(screen.getByRole('textbox'), { clipboardData: { files: [new File(['x'], 'shot.png', { type: 'image/png' })] } });
    expect(await screen.findByAltText('Screenshot 1')).toBeInTheDocument();
    await userEvent.type(screen.getByRole('textbox'), 'Heading disappears{enter}Every time');
    await userEvent.selectOptions(screen.getByLabelText('Priority'), 'high');
    await userEvent.selectOptions(screen.getByLabelText('Where'), 'editor');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(submit).toHaveBeenCalled());
    await waitFor(() => expect(loadMine()).toHaveLength(1));
    const [m] = loadMine();
    expect(m).toMatchObject({ id: 'r1', type: 'bug', title: 'Heading disappears', description: 'Heading disappears\nEvery time', priority: 'high', area: 'editor', areaLabel: 'Editor', screenshots: 1, files: 0, video: false });
    expect(m!.typeLabel).toBe('Bug');
    expect(typeof m!.pageUrl).toBe('string');
    const raw = localStorage.getItem('shipcue:mine')!;
    expect(raw).not.toMatch(/data:|blob:/);
  });
});

describe('rememberMine', () => {
  it('keeps at most MAX_MINE, newest first', () => {
    for (let i = 0; i < MAX_MINE + 5; i++) rememberMine(full({ id: `r${i}` }));
    const mine = loadMine();
    expect(mine).toHaveLength(MAX_MINE);
    expect(mine[0]!.id).toBe(`r${MAX_MINE + 4}`);
  });

  it('truncates long text and drops the oldest until the list fits the size guard', () => {
    const big = 'x'.repeat(MAX_KEPT_TEXT * 3);
    for (let i = 0; i < MAX_MINE; i++) rememberMine(full({ id: `r${i}`, description: big, context: big }));
    const raw = localStorage.getItem('shipcue:mine')!;
    expect(raw.length).toBeLessThanOrEqual(MAX_MINE_BYTES);
    const mine = loadMine();
    expect(mine[0]!.id).toBe(`r${MAX_MINE - 1}`);
    expect(mine[0]!.description!.length).toBeLessThanOrEqual(MAX_KEPT_TEXT + 1);
    expect(mine[0]!.context!.length).toBeLessThanOrEqual(MAX_KEPT_TEXT + 1);
  });

  it('never stores screenshot or video data, and keeps only known fields', () => {
    rememberMine({ ...full(), screenshot: 'data:image/png;base64,AAAA', video: 'data:video/webm;base64,BBBB' } as unknown as MyReport);
    const raw = localStorage.getItem('shipcue:mine')!;
    expect(raw).not.toContain('data:');
    expect(raw).not.toContain('screenshot"');
    expect(loadMine()[0]!.video).toBeUndefined();
  });

  it('reads old entries (id, type, title, at) as they were', () => {
    localStorage.setItem('shipcue:mine', JSON.stringify([{ id: 'old', type: 'feature', title: 'From 0.25', at: '2026-09-01T00:00:00Z' }]));
    rememberMine(full());
    expect(loadMine().map((m) => m.id)).toEqual(['r1', 'old']);
    expect(loadMine()[1]).toEqual({ id: 'old', type: 'feature', title: 'From 0.25', at: '2026-09-01T00:00:00Z' });
  });
});

function openPanel(props: Partial<React.ComponentProps<typeof ReportButton>> = {}) {
  render(<ReportButton areas={areas} submit={async () => ({ id: 'z' })} {...props} />);
  fireEvent.click(openButton());
}

describe('a Yours item opens its detail', () => {
  it('shows the report read-only, and Back returns to the list; pins still work', async () => {
    localStorage.setItem('shipcue:mine', JSON.stringify([full(), { id: 'old', type: 'feature', title: 'From 0.25', at: '2026-09-01T00:00:00Z' }]));
    openPanel();
    fireEvent.click(await screen.findByRole('button', { name: /^Yours/ }));
    const box = await screen.findByLabelText('Your reports');
    const item = within(box).getByRole('button', { name: 'Open Heading disappears on Enter' });
    item.focus();
    fireEvent.click(item);
    const detail = await screen.findByLabelText('Report details');
    expect(within(detail).getByText('Bug')).toBeInTheDocument();
    expect(within(detail).getByText('High')).toBeInTheDocument();
    expect(within(detail).getByText('Editor')).toBeInTheDocument();
    expect(within(detail).getByText(/It happens on every page\./)).toBeInTheDocument();
    expect(within(detail).getByRole('link', { name: '/notes/1' }).getAttribute('href')).toBe('https://app.example.com/notes/1');
    expect(within(detail).getByLabelText('Context preview')).toHaveTextContent('Child');
    expect(within(detail).getByText('2 screenshots attached')).toBeInTheDocument();
    expect(within(detail).getByText('1 file attached')).toBeInTheDocument();
    expect(within(detail).getByText('Video attached')).toBeInTheDocument();
    expect(within(detail).queryByRole('textbox')).toBeNull();
    fireEvent.click(within(detail).getByRole('button', { name: 'Pin Heading disappears on Enter' }));
    expect(JSON.parse(localStorage.getItem('shipcue:stars')!)).toEqual(['r1']);
    fireEvent.click(within(detail).getByRole('button', { name: 'Back' }));
    expect(screen.queryByLabelText('Report details')).toBeNull();
    // An old entry opens too, and just shows less.
    fireEvent.click(within(screen.getByLabelText('Your reports')).getByRole('button', { name: 'Open From 0.25' }));
    expect(within(await screen.findByLabelText('Report details')).getByText('From 0.25')).toBeInTheDocument();
  });

  it('merges the server status, fix line and PR into the detail when /mine is offered', async () => {
    localStorage.setItem('shipcue:mine', JSON.stringify([full()]));
    const server: MineItem = { id: 'r1', type: 'bug', status: 'fixed', title: 'Heading disappears on Enter', resolution: 'Enter keeps the heading now', prUrl: 'https://github.com/o/r/pull/12', createdAt: '2026-10-03T10:00:01Z', updatedAt: '2026-10-04T00:00:00Z' };
    vi.stubGlobal('fetch', async (url: string) => {
      if (String(url).endsWith('/capabilities')) return new Response(JSON.stringify({ video: null, files: false, mine: true }));
      if (String(url).endsWith('/mine')) return new Response(JSON.stringify({ reports: [server] }));
      return new Response('{}', { status: 404 });
    });
    render(<ReportButton areas={areas} endpoint="/api/shipcue" />);
    fireEvent.click(openButton());
    fireEvent.click(await screen.findByRole('button', { name: /^Yours/ }));
    const box = await screen.findByLabelText('Your reports');
    await within(box).findByText('Fixed');
    fireEvent.click(within(box).getByRole('button', { name: 'Open Heading disappears on Enter' }));
    const detail = await screen.findByLabelText('Report details');
    expect(within(detail).getByText('Fixed')).toBeInTheDocument();
    expect(within(detail).getByText('Enter keeps the heading now')).toBeInTheDocument();
    expect(within(detail).getByRole('link', { name: 'PR #12' }).getAttribute('href')).toBe('https://github.com/o/r/pull/12');
    expect(within(detail).getByText(/It happens on every page\./)).toBeInTheDocument();
  });
});

describe('LocalReports', () => {
  it('lists the reports kept in this browser and opens one, with no server', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    localStorage.setItem('shipcue:mine', JSON.stringify([full(), full({ id: 'r2', title: 'Second one', description: 'Second one', type: 'feature' })]));
    render(<LocalReports />);
    const list = screen.getByLabelText('Your reports');
    expect(within(list).getByText('Second one')).toBeInTheDocument();
    fireEvent.click(within(list).getByRole('button', { name: 'Open Heading disappears on Enter' }));
    const detail = screen.getByLabelText('Report details');
    expect(within(detail).getByText('2 screenshots attached')).toBeInTheDocument();
    fireEvent.click(within(detail).getByRole('button', { name: 'Back' }));
    expect(screen.getByLabelText('Your reports')).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('says so when nothing was sent from this browser', () => {
    render(<LocalReports />);
    expect(screen.getByText('Reports you send from this browser show up here.')).toBeInTheDocument();
  });
});
