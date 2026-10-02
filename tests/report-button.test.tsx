// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReportButton, openReport, closeReport } from '../src/react';

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
    const record = screen.getByRole('button', { name: /record screen/i });
    expect(record.querySelector('svg[data-icon="video"]')).not.toBeNull();
    await userEvent.click(record);
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

describe('ReportButton: watermark', () => {
  it('asks people to star shipcue on GitHub, in a new tab', async () => {
    await openPanel();
    const link = screen.getByRole('link', { name: /star shipcue on github/i });
    expect(link).toHaveAttribute('href', 'https://github.com/cyu60/shipcue');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('keeps it when the panel opens again after a send', async () => {
    await openPanel();
    await userEvent.type(screen.getByRole('textbox'), 'The heading disappears on Enter');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByRole('status');
    await userEvent.click(screen.getByRole('button', { name: 'Report a bug or request a feature' }));
    expect(screen.getByRole('link', { name: /star shipcue on github/i })).toBeInTheDocument();
  });

  it('can be turned off', async () => {
    await openPanel({ watermark: false });
    expect(screen.queryByRole('link', { name: /star shipcue on github/i })).toBeNull();
  });
});

describe('ReportButton: three tabs', () => {
  it('offers Bug, Feature request and Agent task', async () => {
    await openPanel();
    const tabs = screen.getAllByRole('radio').map((r) => r.textContent);
    expect(tabs).toEqual(['Bug', 'Feature request', 'Agent task']);
  });

  it('files an agent task with type task', async () => {
    const submit = await openPanel();
    await userEvent.click(screen.getByRole('radio', { name: 'Agent task' }));
    expect(screen.getByRole('heading', { name: 'New agent task' })).toBeInTheDocument();
    await userEvent.type(screen.getByRole('textbox'), 'Add a CSV export to the reports page');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByRole('status');
    expect((submit.mock.calls[0]![0] as FormData).get('type')).toBe('task');
  });

  it('can limit the tabs with types', async () => {
    await openPanel({ types: ['bug', 'feature'] });
    expect(screen.getAllByRole('radio').map((r) => r.textContent)).toEqual(['Bug', 'Feature request']);
  });

  it('shows a ship on the button', () => {
    render(<ReportButton areas={areas} submit={ok()} />);
    expect(screen.getByRole('button', { name: 'Report a bug or request a feature' }).querySelector('svg[data-icon="ship"]')).not.toBeNull();
  });
});

describe('ReportButton: hotkeys', () => {
  const keys = { bug: ['Ctrl+B'], feature: ['Ctrl+F'], task: ['Ctrl+J'] };
  const press = (code: string, key: string, mods: Record<string, boolean> = { ctrlKey: true }) =>
    fireEvent.keyDown(window, { code, key, ...mods });

  it('opens the panel on the tab the hotkey names', async () => {
    render(<ReportButton areas={areas} submit={ok()} hotkeys={keys} />);
    press('KeyJ', 'j');
    expect(await screen.findByRole('heading', { name: 'New agent task' })).toBeInTheDocument();
    press('KeyB', 'b');
    expect(await screen.findByRole('heading', { name: 'Report a bug' })).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveFocus();
  });

  it('puts the text highlighted on the page in an editable Context box, and sends it', async () => {
    const submit = ok();
    render(<><p>Export the members table as CSV</p><ReportButton areas={areas} submit={submit} hotkeys={keys} /></>);
    const range = document.createRange();
    range.selectNodeContents(screen.getByText('Export the members table as CSV'));
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    press('KeyJ', 'j');
    const context = await screen.findByRole('textbox', { name: 'Context' });
    expect(context).toHaveValue('Export the members table as CSV');
    await userEvent.type(context, ' please');
    await userEvent.type(screen.getByRole('textbox', { name: 'Description' }), 'Add it to the reports page');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByRole('status');
    expect((submit.mock.calls[0]![0] as FormData).get('context')).toBe('Export the members table as CSV please');
  });

  it('lets you remove the context', async () => {
    const submit = ok();
    render(<ReportButton areas={areas} submit={submit} getContext={() => '- block one\n  - child'} />);
    await userEvent.click(screen.getByRole('button', { name: 'Report a bug or request a feature' }));
    expect(screen.getByRole('textbox', { name: 'Context' })).toHaveValue('- block one\n  - child');
    await userEvent.click(screen.getByRole('button', { name: 'Remove context' }));
    expect(screen.queryByRole('textbox', { name: 'Context' })).toBeNull();
    await userEvent.type(screen.getByRole('textbox'), 'The heading disappears on Enter');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByRole('status');
    expect((submit.mock.calls[0]![0] as FormData).get('context')).toBe('');
  });

  it('does not send while an input method is composing', async () => {
    const submit = ok();
    render(<ReportButton areas={areas} submit={submit} hotkeys={keys} />);
    press('KeyB', 'b');
    await userEvent.type(await screen.findByRole('textbox'), 'The heading disappears on Enter');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', code: 'Enter', metaKey: true, isComposing: true });
    expect(submit).not.toHaveBeenCalled();
  });

  it('sends with Cmd or Ctrl+Enter', async () => {
    const submit = ok();
    render(<ReportButton areas={areas} submit={submit} hotkeys={keys} />);
    press('KeyB', 'b');
    await userEvent.type(await screen.findByRole('textbox'), 'The heading disappears on Enter');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', code: 'Enter', ctrlKey: true });
    await screen.findByRole('status');
    expect(submit).toHaveBeenCalledOnce();
  });

  it('can be turned off', () => {
    render(<ReportButton areas={areas} submit={ok()} hotkeys={false} />);
    press('KeyB', 'b');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens from anywhere in the app with openReport', async () => {
    render(<ReportButton areas={areas} submit={ok()} />);
    openReport('feature');
    expect(await screen.findByRole('heading', { name: 'Request a feature' })).toBeInTheDocument();
  });
});

describe('ReportButton: a hotkey always starts a fresh form', () => {
  const keys = { bug: ['Ctrl+B'], feature: ['Ctrl+F'], task: ['Ctrl+J'] };
  const press = (code: string, key: string) => fireEvent.keyDown(window, { code, key, ctrlKey: true });

  it('after a send, the hotkey opens an empty form instead of the thanks screen', async () => {
    render(<ReportButton areas={areas} submit={ok()} hotkeys={keys} />);
    press('KeyB', 'b');
    await userEvent.type(await screen.findByRole('textbox'), 'The heading disappears on Enter');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByRole('status');
    press('KeyF', 'f');
    expect(await screen.findByRole('heading', { name: 'Request a feature' })).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue('');
  });

  it('switching tabs with a hotkey clears the half-written form', async () => {
    render(<ReportButton areas={areas} submit={ok()} hotkeys={keys} />);
    press('KeyB', 'b');
    await userEvent.type(await screen.findByRole('textbox'), 'half a bug report');
    press('KeyJ', 'j');
    expect(await screen.findByRole('heading', { name: 'New agent task' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue('');
  });
});

describe('ReportButton: hooks for host apps', () => {
  it('says when the panel opens and closes', async () => {
    const onOpenChange = vi.fn();
    render(<ReportButton areas={areas} submit={ok()} onOpenChange={onOpenChange} />);
    await userEvent.click(screen.getByRole('button', { name: 'Report a bug or request a feature' }));
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('adds your own tab, drawn inside the same panel, with the draft handed over', async () => {
    render(
      <ReportButton
        areas={areas}
        submit={ok()}
        types={['bug', 'feature']}
        getContext={() => '- a block'}
        hotkeys={{ bug: ['Ctrl+B'], agent: ['Ctrl+J'] }}
        extraTabs={[
          {
            id: 'agent',
            label: 'Agent task',
            title: 'New agent task',
            render: ({ text, context, close }) => (
              <div>
                <p>composer: {text} | {context}</p>
                <button type="button" onClick={close}>done</button>
              </div>
            ),
          },
        ]}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Report a bug or request a feature' }));
    expect(screen.getAllByRole('radio').map((r) => r.textContent)).toEqual(['Bug', 'Feature request', 'Agent task']);
    await userEvent.type(screen.getByRole('textbox', { name: 'Description' }), 'make it a doc');
    await userEvent.click(screen.getByRole('radio', { name: 'Agent task' }));
    expect(screen.getByRole('dialog', { name: 'New agent task' })).toBeInTheDocument();
    expect(screen.getByText('composer: make it a doc | - a block')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens your tab from its hotkey or openReport(id)', async () => {
    render(
      <ReportButton
        areas={areas}
        submit={ok()}
        types={['bug', 'feature']}
        hotkeys={{ agent: ['Ctrl+J'] }}
        extraTabs={[{ id: 'agent', label: 'Agent task', render: () => <p>the composer</p> }]}
      />,
    );
    fireEvent.keyDown(window, { code: 'KeyJ', key: 'j', ctrlKey: true });
    expect(await screen.findByText('the composer')).toBeInTheDocument();
    closeReport();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    openReport('agent');
    expect(await screen.findByText('the composer')).toBeInTheDocument();
  });

  it('closes from anywhere with closeReport', async () => {
    render(<ReportButton areas={areas} submit={ok()} />);
    openReport('bug');
    await screen.findByRole('dialog');
    closeReport();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('ReportButton: no button of its own', () => {
  it('draws no trigger with trigger={false}, and still opens from openReport', async () => {
    render(<ReportButton areas={areas} submit={ok()} trigger={false} />);
    expect(screen.queryByRole('button', { name: 'Report a bug or request a feature' })).toBeNull();
    openReport('feature');
    expect(await screen.findByRole('heading', { name: 'Request a feature' })).toBeInTheDocument();
  });
});

describe('ReportButton: add a screenshot', () => {
  it('is a photo icon, not text', async () => {
    await openPanel();
    const add = screen.getByRole('button', { name: 'Add a screenshot' });
    expect(add.querySelector('svg[data-icon="photo"]')).not.toBeNull();
    expect(add).not.toHaveTextContent('screenshot');
  });
});

describe('ReportButton: after a send you carry on', () => {
  it('closes the panel and says it was sent in a short note', async () => {
    const submit = ok();
    render(<ReportButton areas={areas} submit={submit} pastReportsHref="/reports" />);
    await userEvent.click(screen.getByRole('button', { name: 'Report a bug or request a feature' }));
    await userEvent.type(screen.getByRole('textbox'), 'The heading disappears on Enter');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    const note = await screen.findByRole('status');
    expect(note).toHaveTextContent('Thanks. It is in the queue.');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('link', { name: 'See your reports' })).toHaveAttribute('href', '/reports');
  });

  it('opens on an empty form next time', async () => {
    render(<ReportButton areas={areas} submit={ok()} />);
    const fab = screen.getByRole('button', { name: 'Report a bug or request a feature' });
    await userEvent.click(fab);
    await userEvent.type(screen.getByRole('textbox'), 'The heading disappears on Enter');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByRole('status');
    await userEvent.click(fab);
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue('');
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('showParam (?shipcue=true)', () => {
  it('stays hidden until the page is opened with the param, then remembers it for the tab', async () => {
    const { shownByParam } = await import('../src/react');
    sessionStorage.clear();
    window.history.replaceState(null, '', '/page');
    expect(shownByParam('shipcue')).toBe(false);
    window.history.replaceState(null, '', '/page?shipcue=true');
    expect(shownByParam('shipcue')).toBe(true);
    window.history.replaceState(null, '', '/other');
    expect(shownByParam('shipcue')).toBe(true);
    window.history.replaceState(null, '', '/other?shipcue=false');
    expect(shownByParam('shipcue')).toBe(false);
  });
});
