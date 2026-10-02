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

describe('ReportButton: video, page, errors and past reports', () => {
  const type = async () => userEvent.type(screen.getByRole('textbox'), 'The heading vanished on Enter');
  it('lets you leave the page address off', async () => {
    const submit = await openPanel();
    await type();
    await userEvent.click(screen.getByRole('button', { name: /don.t attach/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(submit).toHaveBeenCalled());
    expect((submit.mock.calls[0]![0] as FormData).get('pageUrl')).toBe('');
  });
  it('uploads an attached video after the report is filed, through uploadVideo', async () => {
    const uploadVideo = vi.fn(async (_id: string, _b: Blob) => {});
    await openPanel({ uploadVideo });
    await type();
    const clip = new File([new Uint8Array(2048)], 'clip.mp4', { type: 'video/mp4' });
    fireEvent.change(screen.getByLabelText(/attach a video/i), { target: { files: [clip] } });
    expect(screen.getByText('2 KB')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(uploadVideo).toHaveBeenCalledWith('r1', clip));
  });
  it('posts the video to the handler when no uploadVideo is given', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      new Response(JSON.stringify(String(url).endsWith('/reports') ? { id: 'r9' } : { ok: true }), { status: String(url).endsWith('/reports') ? 201 : 200 }),
    );
    render(<ReportButton areas={areas} endpoint="/api/shipcue" />);
    await userEvent.click(screen.getByRole('button', { name: 'Report a bug or request a feature' }));
    await type();
    fireEvent.change(screen.getByLabelText(/attach a video/i), { target: { files: [new File(['x'], 'c.webm', { type: 'video/webm' })] } });
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(fetchSpy.mock.calls.map((c) => String(c[0]))).toContain('/api/shipcue/reports/r9/video'));
    fetchSpy.mockRestore();
  });
  it('still files the report when the video fails, and says so', async () => {
    await openPanel({ uploadVideo: vi.fn(async () => { throw new Error('Storage is full'); }) });
    await type();
    fireEvent.change(screen.getByLabelText(/attach a video/i), { target: { files: [new File(['x'], 'c.webm', { type: 'video/webm' })] } });
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText(/the video was not attached: storage is full/i)).toBeInTheDocument();
  });
  it('refuses files that are not videos', async () => {
    await openPanel({ uploadVideo: vi.fn() });
    fireEvent.change(screen.getByLabelText(/attach a video/i), { target: { files: [new File(['x'], 'a.pdf', { type: 'application/pdf' })] } });
    expect(screen.getByText(/attach a webm, mp4 or mov video/i)).toBeInTheDocument();
  });
  it('offers screen recording where the browser can do it', async () => {
    const getDisplayMedia = vi.fn(async () => { throw new DOMException('no', 'NotAllowedError'); });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getDisplayMedia } });
    (globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder = class { static isTypeSupported() { return true; } };
    await openPanel({ uploadVideo: vi.fn() });
    await userEvent.click(screen.getByRole('button', { name: /record screen/i }));
    expect(getDisplayMedia).toHaveBeenCalled();
    delete (globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder;
  });
  it('hides video when there is nowhere to send it', async () => {
    await openPanel(); // submit given, no uploadVideo
    expect(screen.queryByLabelText(/attach a video/i)).not.toBeInTheDocument();
  });
  it('attaches recent errors to the report by default', async () => {
    const submit = await openPanel({ diagnostics: () => ({ blocks: 3 }) });
    window.dispatchEvent(new ErrorEvent('error', { message: 'Cannot read x', filename: 'app.js', lineno: 9 }));
    await type();
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(submit).toHaveBeenCalled());
    const diag = JSON.parse(String((submit.mock.calls[0]![0] as FormData).get('diagnostics')));
    expect(diag.blocks).toBe(3);
    expect(diag.recentErrors.map((e: { text: string }) => e.text)).toContain('Cannot read x at app.js:9');
  });
  it('can leave error capture off', async () => {
    const submit = await openPanel({ captureErrors: false });
    window.dispatchEvent(new ErrorEvent('error', { message: 'Hidden' }));
    await type();
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(submit).toHaveBeenCalled());
    expect(String((submit.mock.calls[0]![0] as FormData).get('diagnostics'))).not.toContain('Hidden');
  });
  it('links to past reports when given a link', async () => {
    await openPanel({ pastReportsHref: '/reports' });
    expect(screen.getByRole('link', { name: /past reports/i })).toHaveAttribute('href', '/reports');
  });
});
