// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReportButton, openReport, type DraftStore, type SavedDraft } from '../src/react';

// A draft not sent yet survives leaving the app (Habitect report e1204c25).
beforeAll(() => {
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
});
afterEach(cleanup);

type Result = { id: string } | { error: string };
const areas = [{ value: 'editor', label: 'Editor' }];
const openButton = () => screen.getByRole('button', { name: 'Report a bug or request a feature' });
const box = () => screen.getByRole('textbox');

/** What a browser keeps between page loads, in memory. */
function memoryStore(initial: SavedDraft | null = null) {
  let kept = initial;
  const store: DraftStore & { kept: () => SavedDraft | null } = {
    load: vi.fn(async () => kept),
    save: vi.fn(async (d: SavedDraft) => {
      kept = d;
    }),
    clear: vi.fn(async () => {
      kept = null;
    }),
    kept: () => kept,
  };
  return store;
}

const hide = () => {
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
};

describe('ReportButton persistDraft', () => {
  it('keeps the text and screenshots when the page is hidden, and brings them back on the next load', async () => {
    const store = memoryStore();
    const submit = vi.fn(async (_f: FormData): Promise<Result> => ({ id: 'r1' }));
    render(<ReportButton areas={areas} submit={submit} persistDraft={store} />);
    await userEvent.click(openButton());
    await userEvent.click(screen.getByRole('radio', { name: 'Feature request' }));
    await userEvent.type(box(), 'Keep what I wrote');
    fireEvent.paste(box(), { clipboardData: { files: [new File(['x'], 'shot.png', { type: 'image/png' })] } });
    expect(await screen.findByAltText('Screenshot 1')).toBeInTheDocument();
    act(hide);
    await waitFor(() => expect(store.kept()?.files).toHaveLength(1));
    expect(store.kept()).toMatchObject({ type: 'feature', text: 'Keep what I wrote' });

    // The phone dropped the tab: a new page load.
    cleanup();
    render(<ReportButton areas={areas} submit={submit} persistDraft={store} />);
    await waitFor(() => expect(store.load).toHaveBeenCalledTimes(2));
    await userEvent.click(openButton());
    expect(await screen.findByDisplayValue('Keep what I wrote')).toBeInTheDocument();
    expect(screen.getByAltText('Screenshot 1')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Feature request' })).toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(submit).toHaveBeenCalled());
    expect(submit.mock.calls[0]![0].getAll('screenshot')).toHaveLength(1);
    // Sent: nothing is kept any more.
    await waitFor(() => expect(store.kept()).toBeNull());
  });

  it('a fresh openReport starts an empty form and drops the kept draft', async () => {
    const store = memoryStore({ type: 'bug', text: 'Old draft', context: null, files: [], alts: [], key: null });
    render(<ReportButton areas={areas} submit={vi.fn()} persistDraft={store} />);
    await waitFor(() => expect(store.load).toHaveBeenCalled());
    act(() => openReport('feature'));
    expect(box()).toHaveValue('');
    await waitFor(() => expect(store.kept()).toBeNull());
  });

  it('a fresh openReport made before the draft was read back still wins', async () => {
    let resolve: (d: SavedDraft) => void = () => undefined;
    const store: DraftStore = {
      load: () => new Promise((r) => (resolve = r)),
      save: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
    };
    render(<ReportButton areas={areas} submit={vi.fn()} persistDraft={store} />);
    act(() => openReport('bug'));
    await act(async () => resolve({ type: 'bug', text: 'Old draft', context: null, files: [], alts: [], key: null }));
    expect(box()).toHaveValue('');
    await waitFor(() => expect(store.clear).toHaveBeenCalled());
  });

  it('openReport with keepDraft opens on the draft as it was, and on the asked tab only when there is none', async () => {
    const store = memoryStore({ type: 'bug', text: 'Half written', context: null, files: [], alts: [], key: null });
    render(<ReportButton areas={areas} submit={vi.fn()} persistDraft={store} />);
    await waitFor(() => expect(store.load).toHaveBeenCalled());
    act(() => openReport('feature', { keepDraft: true }));
    expect(await screen.findByDisplayValue('Half written')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Bug' })).toBeChecked();

    await userEvent.clear(box());
    await userEvent.keyboard('{Escape}');
    act(() => openReport('feature', { keepDraft: true }));
    expect(box()).toHaveValue('');
    expect(screen.getByRole('radio', { name: 'Feature request' })).toBeChecked();
  });

  it('keepDraft keeps the in-memory draft without persistDraft too', async () => {
    render(<ReportButton areas={areas} submit={vi.fn()} />);
    await userEvent.click(openButton());
    await userEvent.type(box(), 'Not lost on reopen');
    await userEvent.keyboard('{Escape}');
    act(() => openReport('feature', { keepDraft: true }));
    expect(box()).toHaveValue('Not lost on reopen');
  });

  it('keeps nothing without persistDraft', async () => {
    const store = memoryStore();
    render(<ReportButton areas={areas} submit={vi.fn()} />);
    await userEvent.click(openButton());
    await userEvent.type(box(), 'Only in memory');
    act(hide);
    expect(store.save).not.toHaveBeenCalled();
  });
});
