// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReportButton } from '../src/react';

beforeAll(() => {
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
});
afterEach(cleanup);

const areas = [{ value: 'editor', label: 'Editor' }];
const ok = () => vi.fn(async (_f: FormData) => ({ id: 'r1' }) as { id: string } | { error: string });

async function openPanel(props: Partial<Parameters<typeof ReportButton>[0]> = {}) {
  const submit = (props.submit as ReturnType<typeof ok>) ?? ok();
  render(<ReportButton areas={areas} submit={submit} {...props} />);
  await userEvent.click(screen.getByRole('button', { name: 'Report a bug or request a feature' }));
  return submit;
}

describe('ReportButton', () => {
  it('opens a panel with the text box focused', async () => {
    await openPanel();
    expect(screen.getByRole('dialog', { name: 'Report a bug' })).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveFocus();
  });

  it('switches the heading for feature requests', async () => {
    await openPanel();
    await userEvent.click(screen.getByRole('radio', { name: 'Feature request' }));
    expect(screen.getByRole('heading', { name: 'Request a feature' })).toBeInTheDocument();
  });

  it('offers your areas plus Other', async () => {
    await openPanel();
    const options = Array.from((screen.getByLabelText('Where') as HTMLSelectElement).options).map((o) => o.text);
    expect(options).toEqual(['Editor', 'Other']);
  });

  it('keeps Send off until there are 10 characters', async () => {
    await openPanel();
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toBeDisabled();
    await userEvent.type(screen.getByRole('textbox'), 'Too short');
    expect(send).toBeDisabled();
    await userEvent.type(screen.getByRole('textbox'), '!!');
    expect(send).toBeEnabled();
  });

  it('sends every field, the page and the app snapshot', async () => {
    const submit = await openPanel({ diagnostics: () => ({ blocks: 4 }) });
    await userEvent.type(screen.getByRole('textbox'), 'Heading disappears on Enter');
    await userEvent.selectOptions(screen.getByLabelText('Priority'), 'high');
    await userEvent.selectOptions(screen.getByLabelText('Where'), 'editor');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    const form = submit.mock.calls[0]![0];
    expect(Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === 'string'))).toMatchObject({
      type: 'bug',
      priority: 'high',
      area: 'editor',
      description: 'Heading disappears on Enter',
      pageUrl: window.location.href,
      diagnostics: '{"blocks":4}',
    });
    expect(await screen.findByText(/Thanks/)).toBeInTheDocument();
  });

  it('still sends when the diagnostics callback throws', async () => {
    const submit = await openPanel({
      diagnostics: () => {
        throw new Error('boom');
      },
    });
    await userEvent.type(screen.getByRole('textbox'), 'Heading disappears on Enter');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(submit.mock.calls[0]![0].get('diagnostics')).toBe('{"diagnosticsError":"boom"}');
  });

  it('shows the server error and keeps the text', async () => {
    const submit = vi.fn(async () => ({ error: 'Sign in to send a report.' }));
    await openPanel({ submit });
    await userEvent.type(screen.getByRole('textbox'), 'Heading disappears on Enter');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Sign in to send a report.')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('Heading disappears on Enter');
  });

  it('attaches a pasted screenshot and sends it', async () => {
    const submit = await openPanel();
    const img = new File(['x'], 'shot.png', { type: 'image/png' });
    fireEvent.paste(screen.getByRole('textbox'), { clipboardData: { files: [img] } });
    expect(await screen.findByAltText('Screenshot 1')).toBeInTheDocument();
    await userEvent.type(screen.getByRole('textbox'), 'Heading disappears on Enter');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(submit).toHaveBeenCalled());
    expect(submit.mock.calls[0]![0].getAll('screenshot')).toHaveLength(1);
  });

  it('closes on Escape', async () => {
    await openPanel();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('posts to the endpoint when no submit is given', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ id: 'r9' }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<ReportButton areas={areas} endpoint="/api/fq" />);
    await userEvent.click(screen.getByRole('button', { name: 'Report a bug or request a feature' }));
    await userEvent.type(screen.getByRole('textbox'), 'Heading disappears on Enter');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/fq/reports');
    vi.unstubAllGlobals();
  });
});
