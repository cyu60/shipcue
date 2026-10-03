// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReportButton, Lightbox, selectArea } from '../src/react';
import { captureArea } from '../src/react/capture';

// Select an area, capture it, mark it up, attach it with alt text (shipcue report 58b727d9).
// jsdom has no canvas, video or screen capture: light stubs stand in for them.

const drawImage = vi.fn();
const ctx = new Proxy({ drawImage, canvas: { width: 0, height: 0 } } as Record<string, unknown>, {
  get: (t, k) => (k in t ? t[k as string] : () => undefined),
  set: (t, k, v) => ((t[k as string] = v), true),
});
let blobBytes = 60;
class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  width = 200;
  height = 100;
  set src(_v: string) {
    setTimeout(() => this.onload?.(), 0);
  }
}
const stop = vi.fn();
// Each share is its own track, so a test can end one ("Stop sharing") and see a fresh request.
const tracks: { stop: () => void; readyState: string }[] = [];
const getDisplayMedia = vi.fn(async (_o?: unknown) => {
  const track = { readyState: 'live', stop: () => ((track.readyState = 'ended'), stop()) };
  tracks.push(track);
  return { getTracks: () => [track], getVideoTracks: () => [track] };
});

beforeAll(() => {
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ctx) as never;
  HTMLCanvasElement.prototype.toBlob = function (cb: BlobCallback) {
    cb(new Blob([new Uint8Array(blobBytes)], { type: 'image/png' }));
  };
  HTMLMediaElement.prototype.play = vi.fn(async () => undefined);
  Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { configurable: true, get: () => 1600 });
  Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { configurable: true, get: () => 1200 });
});
beforeEach(() => {
  vi.stubGlobal('Image', FakeImage);
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getDisplayMedia } });
  window.innerWidth = 800;
  window.innerHeight = 600;
  blobBytes = 60;
  drawImage.mockClear();
  stop.mockClear();
  getDisplayMedia.mockClear();
  tracks.length = 0;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const ok = () => vi.fn(async (_f: FormData) => ({ id: 'r1' }) as { id: string } | { error: string });
async function openPanel(props: Partial<Parameters<typeof ReportButton>[0]> = {}) {
  const submit = (props.submit as ReturnType<typeof ok>) ?? ok();
  render(<ReportButton areas={[]} submit={submit} {...props} />);
  await userEvent.click(screen.getByRole('button', { name: 'Report a bug or request a feature' }));
  return submit;
}
const toolbar = () => screen.getByRole('toolbar', { name: 'Selection' });
const captureAndAnnotate = () => userEvent.click(within(toolbar()).getByRole('button', { name: 'Capture & annotate' }));
const drag = (from: [number, number], to: [number, number]) => {
  const layer = screen.getByRole('dialog', { name: 'Select an area' });
  fireEvent.pointerDown(layer, { button: 0, clientX: from[0], clientY: from[1], pointerId: 1 });
  fireEvent.pointerMove(layer, { clientX: to[0], clientY: to[1], pointerId: 1 });
  fireEvent.pointerUp(layer, { clientX: to[0], clientY: to[1], pointerId: 1 });
};

describe('Select area', () => {
  it('tints the page, hides the panel, and Esc cancels back to the form', async () => {
    await openPanel();
    await userEvent.type(screen.getByRole('textbox'), 'The heading vanished');
    await userEvent.click(screen.getByRole('button', { name: 'Select area' }));
    const layer = screen.getByRole('dialog', { name: 'Select an area' });
    expect(layer).toHaveStyle({ cursor: 'crosshair' });
    expect(screen.getByRole('status')).toHaveTextContent('Drag to select an area');
    expect(screen.queryByRole('dialog', { name: 'Report a bug' })).toBeNull();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Select an area' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Report a bug' })).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('The heading vanished');
  });

  it('opens from its hotkey, even with the panel closed, and shows the size while dragging', async () => {
    render(<ReportButton areas={[]} submit={ok()} hotkeys={{ selectArea: ['Alt+K'] }} />);
    fireEvent.keyDown(window, { code: 'KeyK', key: 'k', altKey: true });
    const layer = screen.getByRole('dialog', { name: 'Select an area' });
    fireEvent.pointerDown(layer, { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(layer, { clientX: 130, clientY: 90, pointerId: 1 });
    expect(screen.getByText('120 × 80')).toBeInTheDocument();
    expect(document.querySelector('[data-shipcue-selection]')).toHaveStyle({ left: '10px', top: '10px', width: '120px', height: '80px' });
  });

  it('starts from selectArea() in the app, even with the panel closed (a command palette, say)', async () => {
    render(<ReportButton areas={[]} submit={ok()} hotkeys={false} />);
    act(() => selectArea());
    expect(screen.getByRole('dialog', { name: 'Select an area' })).toBeInTheDocument();
  });

  it('is in the Shortcuts list, so it can be changed like the others', async () => {
    await openPanel();
    await userEvent.click(screen.getByRole('button', { name: 'Shortcuts' }));
    expect(screen.getByLabelText('Shortcuts')).toHaveTextContent('Select area');
  });

  it('captures the tab once, crops at devicePixelRatio, opens the annotator, and stops sharing when the panel closes', async () => {
    const submit = await openPanel();
    await userEvent.click(screen.getByRole('button', { name: 'Select area' }));
    drag([100, 50], [300, 150]);
    await captureAndAnnotate();
    expect(await screen.findByRole('dialog', { name: 'Mark up the screenshot' })).toBeInTheDocument();
    expect(getDisplayMedia).toHaveBeenCalledWith(expect.objectContaining({ video: { displaySurface: 'browser' }, preferCurrentTab: true, selfBrowserSurface: 'include' }));
    // Kept for the next capture while the panel is open (shipcue report 03de1f12).
    expect(stop).not.toHaveBeenCalled();
    // An 800px viewport captured at 1600px: 2x.
    expect(drawImage.mock.calls[0]!.slice(1)).toEqual([200, 100, 400, 200, 0, 0, 400, 200]);
    await userEvent.type(screen.getByPlaceholderText(/for screen readers/), 'Save button greyed out');
    await userEvent.click(screen.getByRole('button', { name: 'Add to report' }));
    expect(await screen.findByAltText('Save button greyed out')).toBeInTheDocument();
    await userEvent.type(screen.getByRole('textbox', { name: 'Description' }), 'The heading vanished on Enter');
    await userEvent.click(screen.getByRole('button', { name: /Send/ }));
    await waitFor(() => expect(submit).toHaveBeenCalled());
    const form = submit.mock.calls[0]![0];
    expect(form.getAll('screenshot')).toHaveLength(1);
    expect(form.getAll('screenshotAlt')).toEqual(['Save button greyed out']);
    // Sent: the panel closed, and sharing stopped with it.
    await waitFor(() => expect(stop).toHaveBeenCalled());
  });

  it('says so in one line when the person declines to share', async () => {
    getDisplayMedia.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
    await openPanel();
    await userEvent.click(screen.getByRole('button', { name: 'Select area' }));
    drag([100, 50], [300, 150]);
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('Screen capture was not allowed. Paste a screenshot instead.');
    expect(screen.queryByRole('dialog', { name: 'Mark up the screenshot' })).toBeNull();
  });

  it('says so where the browser cannot capture, without a tint', async () => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
    await openPanel();
    await userEvent.click(screen.getByRole('button', { name: 'Select area' }));
    expect(screen.getByRole('alert')).toHaveTextContent('This browser cannot capture the page.');
    expect(screen.queryByRole('dialog', { name: 'Select an area' })).toBeNull();
  });

  it('keeps to the screenshot limits', async () => {
    await openPanel({ limits: { maxScreenshots: 2, maxTotalScreenshotBytes: 100 } });
    fireEvent.paste(screen.getByRole('textbox'), { clipboardData: { files: [new File([new Uint8Array(50)], 'a.png', { type: 'image/png' })] } });
    await screen.findByAltText('Screenshot 1');
    await userEvent.click(screen.getByRole('button', { name: 'Select area' }));
    drag([0, 0], [100, 100]);
    await captureAndAnnotate();
    await userEvent.click(await screen.findByRole('button', { name: 'Add to report' }));
    expect(await screen.findByText(/That is all the screenshots one report can carry/)).toBeInTheDocument();
    expect(screen.getAllByAltText(/^Screenshot \d$/)).toHaveLength(1);
  });

  it('hides the Select area tile once the report has all its screenshots', async () => {
    await openPanel({ limits: { maxScreenshots: 1 } });
    fireEvent.paste(screen.getByRole('textbox'), { clipboardData: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } });
    await screen.findByAltText('Screenshot 1');
    expect(screen.queryByRole('button', { name: 'Select area' })).toBeNull();
  });
});

describe('the annotator', () => {
  it('re-opens a pasted screenshot, undoes and redoes, and swaps the edit in with its alt text', async () => {
    const submit = await openPanel();
    fireEvent.paste(screen.getByRole('textbox'), { clipboardData: { files: [new File(['x'], 'shot.png', { type: 'image/png' })] } });
    await userEvent.click(await screen.findByRole('button', { name: 'Edit screenshot 1' }));
    const dialog = await screen.findByRole('dialog', { name: 'Mark up the screenshot' });
    const canvas = dialog.querySelector('canvas')!;
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add to report' })).toBeEnabled());
    const undoBtn = screen.getByRole('button', { name: 'Undo' });
    expect(undoBtn).toBeDisabled();
    await userEvent.click(screen.getByRole('radio', { name: 'Box' }));
    fireEvent.pointerDown(canvas, { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 60, clientY: 40, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: 60, clientY: 40, pointerId: 1 });
    expect(undoBtn).toBeEnabled();
    fireEvent.keyDown(window, { code: 'KeyZ', key: 'z', ctrlKey: true });
    expect(undoBtn).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Redo' })).toBeEnabled();
    fireEvent.keyDown(window, { code: 'KeyZ', key: 'Z', ctrlKey: true, shiftKey: true });
    expect(undoBtn).toBeEnabled();
    // Tool keys pick tools.
    fireEvent.keyDown(window, { code: 'KeyP', key: 'p' });
    expect(screen.getByRole('radio', { name: 'Draw' })).toHaveAttribute('aria-checked', 'true');
    await userEvent.type(screen.getByPlaceholderText(/for screen readers/), 'Empty members table');
    await userEvent.click(screen.getByRole('button', { name: 'Add to report' }));
    expect(await screen.findByAltText('Empty members table')).toBeInTheDocument();
    expect(screen.queryByAltText('Screenshot 2')).toBeNull();
    await userEvent.type(screen.getByRole('textbox', { name: 'Description' }), 'Members table is empty');
    await userEvent.click(screen.getByRole('button', { name: /Send/ }));
    await waitFor(() => expect(submit).toHaveBeenCalled());
    expect(submit.mock.calls[0]![0].getAll('screenshotAlt')).toEqual(['Empty members table']);
  });

  it('keeps a fast drag whose events arrive between renders', async () => {
    await openPanel();
    fireEvent.paste(screen.getByRole('textbox'), { clipboardData: { files: [new File(['x'], 'shot.png', { type: 'image/png' })] } });
    await userEvent.click(await screen.findByRole('button', { name: 'Edit screenshot 1' }));
    const canvas = (await screen.findByRole('dialog', { name: 'Mark up the screenshot' })).querySelector('canvas')!;
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add to report' })).toBeEnabled());
    act(() => {
      fireEvent.pointerDown(canvas, { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
      fireEvent.pointerMove(canvas, { clientX: 80, clientY: 60, pointerId: 1 });
      fireEvent.pointerUp(canvas, { clientX: 80, clientY: 60, pointerId: 1 });
    });
    expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled();
  });

  it('Esc closes it without touching the report, and the panel stays open', async () => {
    await openPanel();
    fireEvent.paste(screen.getByRole('textbox'), { clipboardData: { files: [new File(['x'], 'shot.png', { type: 'image/png' })] } });
    await userEvent.click(await screen.findByRole('button', { name: 'Edit screenshot 1' }));
    await screen.findByRole('dialog', { name: 'Mark up the screenshot' });
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Mark up the screenshot' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Report a bug' })).toBeInTheDocument();
    expect(screen.getByAltText('Screenshot 1')).toBeInTheDocument();
  });

  it('sends no screenshotAlt field when no screenshot has alt text', async () => {
    const submit = await openPanel();
    fireEvent.paste(screen.getByRole('textbox'), { clipboardData: { files: [new File(['x'], 'shot.png', { type: 'image/png' })] } });
    await screen.findByAltText('Screenshot 1');
    await userEvent.type(screen.getByRole('textbox', { name: 'Description' }), 'The heading vanished on Enter');
    await userEvent.click(screen.getByRole('button', { name: /Send/ }));
    await waitFor(() => expect(submit).toHaveBeenCalled());
    expect(submit.mock.calls[0]![0].getAll('screenshotAlt')).toEqual([]);
  });
});

describe('capture on open (shipcue report 503aa011)', () => {
  const tint = () => document.querySelector('[data-shipcue-capture]') as HTMLElement | null;
  const dragTint = (from: [number, number], to: [number, number]) => {
    const el = tint()!;
    fireEvent.pointerDown(el, { button: 0, clientX: from[0], clientY: from[1], pointerId: 1 });
    fireEvent.pointerMove(el, { clientX: to[0], clientY: to[1], pointerId: 1 });
    fireEvent.pointerUp(el, { clientX: to[0], clientY: to[1], pointerId: 1 });
  };

  it('tints the page as soon as the panel opens, with a one-line hint, under the panel', async () => {
    await openPanel();
    const el = tint();
    expect(el).not.toBeNull();
    expect(el).toHaveStyle({ position: 'fixed', cursor: 'crosshair' });
    expect(el).toHaveTextContent('Drag to capture part of the page · click to dismiss');
    // Below the panel and its button, so both stay usable.
    expect(Number(el!.style.zIndex)).toBeLessThan(2147483000);
    expect(screen.getByRole('dialog', { name: 'Report a bug' })).toBeInTheDocument();
  });

  it('a drag on the tint selects an area, captures it and opens the annotator', async () => {
    await openPanel();
    const el = tint()!;
    fireEvent.pointerDown(el, { button: 0, clientX: 100, clientY: 50, pointerId: 1 });
    fireEvent.pointerMove(el, { clientX: 300, clientY: 150, pointerId: 1 });
    expect(document.querySelector('[data-shipcue-selection]')).toHaveStyle({ left: '100px', top: '50px', width: '200px', height: '100px' });
    expect(screen.getByText('200 × 100')).toBeInTheDocument();
    fireEvent.pointerUp(el, { clientX: 300, clientY: 150, pointerId: 1 });
    await captureAndAnnotate();
    expect(await screen.findByRole('dialog', { name: 'Mark up the screenshot' })).toBeInTheDocument();
    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
    expect(drawImage.mock.calls[0]!.slice(1)).toEqual([200, 100, 400, 200, 0, 0, 400, 200]);
    await userEvent.click(screen.getByRole('button', { name: 'Add to report' }));
    expect(await screen.findByAltText('Screenshot 1')).toBeInTheDocument();
    // Back at the panel with the page usable: the tint does not come back on its own.
    expect(tint()).toBeNull();
  });

  it('a click without a drag lifts the tint and keeps the panel open; Select area brings it back', async () => {
    await openPanel();
    await userEvent.type(screen.getByRole('textbox'), 'Copy this');
    dragTint([200, 200], [202, 201]);
    expect(tint()).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Report a bug' })).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('Copy this');
    expect(getDisplayMedia).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Select area' }));
    expect(screen.getByRole('dialog', { name: 'Select an area' })).toBeInTheDocument();
  });

  it('a tap (touch pointer) lifts it too', async () => {
    await openPanel();
    const el = tint()!;
    fireEvent.pointerDown(el, { button: 0, pointerType: 'touch', clientX: 50, clientY: 50, pointerId: 2 });
    fireEvent.pointerUp(el, { button: 0, pointerType: 'touch', clientX: 51, clientY: 50, pointerId: 2 });
    expect(tint()).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Report a bug' })).toBeInTheDocument();
  });

  it('a thin stroke past the click threshold is neither a click nor a capture', async () => {
    await openPanel();
    dragTint([100, 100], [300, 103]);
    expect(tint()).not.toBeNull();
    expect(getDisplayMedia).not.toHaveBeenCalled();
  });

  it('Esc lifts the tint first, then a second Esc closes the panel', async () => {
    await openPanel();
    expect(tint()).not.toBeNull();
    await userEvent.keyboard('{Escape}');
    expect(tint()).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Report a bug' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Report a bug' })).toBeNull();
  });

  it('comes back each time the panel opens', async () => {
    await openPanel();
    await userEvent.keyboard('{Escape}');
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByRole('button', { name: 'Report a bug or request a feature' }));
    expect(tint()).not.toBeNull();
  });

  it('typing in the panel never captures', async () => {
    await openPanel();
    await userEvent.type(screen.getByRole('textbox'), 'Enter does nothing here{Enter}and arrows{ArrowLeft}{ArrowUp}');
    expect(getDisplayMedia).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Mark up the screenshot' })).toBeNull();
    expect(tint()).not.toBeNull();
    expect(screen.getByRole('textbox')).toHaveFocus();
  });

  it('captureOnOpen={false} keeps the old behaviour: no tint until Select area', async () => {
    await openPanel({ captureOnOpen: false });
    expect(tint()).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Select area' }));
    drag([100, 50], [300, 150]);
    await captureAndAnnotate();
    expect(await screen.findByRole('dialog', { name: 'Mark up the screenshot' })).toBeInTheDocument();
  });

  it('is off for the inline variant unless asked for', async () => {
    await openPanel({ variant: 'inline' });
    expect(tint()).toBeNull();
    cleanup();
    await openPanel({ variant: 'inline', captureOnOpen: true });
    expect(tint()).not.toBeNull();
  });

  it('is not there where the browser cannot capture', async () => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
    await openPanel();
    expect(tint()).toBeNull();
  });
});

describe('adjust before capturing (shipcue report 03de1f12)', () => {
  const sel = () => document.querySelector('[data-shipcue-selection]') as HTMLElement;
  const layer = () => screen.getByRole('dialog', { name: 'Select an area' });
  const startSelecting = async (props: Partial<Parameters<typeof ReportButton>[0]> = {}) => {
    const submit = await openPanel(props);
    await userEvent.click(screen.getByRole('button', { name: 'Select area' }));
    drag([100, 50], [300, 150]);
    return submit;
  };
  const press = (el: Element, from: [number, number], to: [number, number]) => {
    fireEvent.pointerDown(el, { button: 0, clientX: from[0], clientY: from[1], pointerId: 1 });
    fireEvent.pointerMove(el, { clientX: to[0], clientY: to[1], pointerId: 1 });
    fireEvent.pointerUp(el, { clientX: to[0], clientY: to[1], pointerId: 1 });
  };

  it('letting go keeps the selection, with handles and a toolbar, and asks for nothing yet', async () => {
    await startSelecting();
    expect(sel()).toHaveStyle({ left: '100px', top: '50px', width: '200px', height: '100px' });
    expect(document.querySelectorAll('[data-shipcue-handle]')).toHaveLength(8);
    expect(within(toolbar()).getByRole('textbox', { name: 'Width' })).toHaveValue('200');
    expect(within(toolbar()).getByRole('textbox', { name: 'Height' })).toHaveValue('100');
    expect(within(toolbar()).getByRole('button', { name: 'Capture' })).toBeInTheDocument();
    expect(within(toolbar()).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    // Just below the selection.
    expect(toolbar()).toHaveStyle({ top: '158px' });
    expect(getDisplayMedia).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Mark up the screenshot' })).toBeNull();
  });

  it('flips the toolbar above a selection near the bottom edge', async () => {
    await openPanel();
    await userEvent.click(screen.getByRole('button', { name: 'Select area' }));
    drag([100, 450], [300, 590]);
    expect(parseFloat(toolbar().style.top)).toBeLessThan(450);
  });

  it('resizes from a handle and from the size fields, inside the viewport', async () => {
    await startSelecting();
    press(document.querySelector('[data-shipcue-handle="se"]')!, [300, 150], [360, 190]);
    expect(sel()).toHaveStyle({ left: '100px', top: '50px', width: '260px', height: '140px' });
    press(document.querySelector('[data-shipcue-handle="nw"]')!, [100, 50], [80, 40]);
    expect(sel()).toHaveStyle({ left: '80px', top: '40px', width: '280px', height: '150px' });
    fireEvent.change(within(toolbar()).getByRole('textbox', { name: 'Width' }), { target: { value: '320' } });
    fireEvent.change(within(toolbar()).getByRole('textbox', { name: 'Height' }), { target: { value: '9999' } });
    // From the top-left; the height stops at the bottom of the viewport.
    expect(sel()).toHaveStyle({ left: '80px', top: '40px', width: '320px', height: '560px' });
    expect(getDisplayMedia).not.toHaveBeenCalled();
  });

  it('moves when dragged from inside, and with the arrow keys', async () => {
    await startSelecting();
    press(sel(), [150, 100], [250, 140]);
    expect(sel()).toHaveStyle({ left: '200px', top: '90px', width: '200px', height: '100px' });
    // Never off the page.
    press(sel(), [250, 140], [2000, 140]);
    expect(sel()).toHaveStyle({ left: '600px' });
    await userEvent.keyboard('{ArrowLeft}');
    expect(sel()).toHaveStyle({ left: '590px' });
    expect(getDisplayMedia).not.toHaveBeenCalled();
  });

  it('a new drag outside the selection starts a fresh one; a click keeps it', async () => {
    await startSelecting();
    fireEvent.pointerDown(layer(), { button: 0, clientX: 500, clientY: 400, pointerId: 1 });
    fireEvent.pointerUp(layer(), { button: 0, clientX: 500, clientY: 400, pointerId: 1 });
    expect(sel()).toHaveStyle({ left: '100px', top: '50px' });
    press(layer(), [400, 300], [600, 450]);
    expect(sel()).toHaveStyle({ left: '400px', top: '300px', width: '200px', height: '150px' });
  });

  it('Enter captures it (one share request) and attaches it without the annotator', async () => {
    await startSelecting();
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByAltText('Screenshot 1')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Mark up the screenshot' })).toBeNull();
    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
    expect(drawImage.mock.calls[0]!.slice(1)).toEqual([200, 100, 400, 200, 0, 0, 400, 200]);
  });

  it('a second capture in the same open panel reuses the share; closing the panel stops it', async () => {
    await startSelecting();
    await userEvent.keyboard('{Enter}');
    await screen.findByAltText('Screenshot 1');
    await userEvent.click(screen.getByRole('button', { name: 'Select area' }));
    drag([10, 10], [110, 60]);
    await userEvent.click(within(toolbar()).getByRole('button', { name: 'Capture' }));
    expect(await screen.findByAltText('Screenshot 2')).toBeInTheDocument();
    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
    expect(drawImage.mock.calls[1]!.slice(1)).toEqual([20, 20, 200, 100, 0, 0, 200, 100]);
    expect(stop).not.toHaveBeenCalled();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Report a bug' })).toBeNull();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('asks again when sharing was stopped from the browser', async () => {
    await startSelecting();
    await userEvent.keyboard('{Enter}');
    await screen.findByAltText('Screenshot 1');
    tracks[0]!.readyState = 'ended';
    await userEvent.click(screen.getByRole('button', { name: 'Select area' }));
    drag([10, 10], [110, 60]);
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByAltText('Screenshot 2')).toBeInTheDocument();
    expect(getDisplayMedia).toHaveBeenCalledTimes(2);
  });

  it('stops sharing when the page is hidden, and after captureKeepAlive ms idle', async () => {
    await startSelecting();
    await userEvent.keyboard('{Enter}');
    await screen.findByAltText('Screenshot 1');
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    fireEvent(document, new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    expect(stop).toHaveBeenCalledTimes(1);
    cleanup();
    stop.mockClear();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await startSelecting({ captureKeepAlive: 1000 });
      await userEvent.keyboard('{Enter}');
      await screen.findByAltText('Screenshot 1');
      expect(stop).not.toHaveBeenCalled();
      act(() => void vi.advanceTimersByTime(1500));
      expect(stop).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Esc cancels back to the form without asking to share', async () => {
    await startSelecting();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Select an area' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Report a bug' })).toBeInTheDocument();
    expect(getDisplayMedia).not.toHaveBeenCalled();
  });

  it('Cancel in the toolbar does the same', async () => {
    await startSelecting();
    await userEvent.click(within(toolbar()).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Select an area' })).toBeNull();
    expect(getDisplayMedia).not.toHaveBeenCalled();
  });

  it('Capture & annotate opens the annotator on the capture', async () => {
    await startSelecting();
    await captureAndAnnotate();
    expect(await screen.findByRole('dialog', { name: 'Mark up the screenshot' })).toBeInTheDocument();
    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
  });

  describe('on the tint that comes with the panel', () => {
    const tint = () => document.querySelector('[data-shipcue-capture]') as HTMLElement;
    it('keeps the selection adjustable too, then Enter captures and a second one reuses the share', async () => {
      await openPanel();
      press(tint(), [100, 50], [300, 150]);
      expect(getDisplayMedia).not.toHaveBeenCalled();
      expect(document.querySelectorAll('[data-shipcue-handle]')).toHaveLength(8);
      press(document.querySelector('[data-shipcue-handle="e"]')!, [300, 100], [340, 100]);
      expect(sel()).toHaveStyle({ width: '240px', height: '100px' });
      expect(within(toolbar()).getByRole('textbox', { name: 'Width' })).toHaveValue('240');
      await userEvent.keyboard('{Enter}');
      expect(await screen.findByAltText('Screenshot 1')).toBeInTheDocument();
      expect(getDisplayMedia).toHaveBeenCalledTimes(1);
      await userEvent.click(screen.getByRole('button', { name: 'Select area' }));
      drag([10, 10], [110, 60]);
      await captureAndAnnotate();
      expect(await screen.findByRole('dialog', { name: 'Mark up the screenshot' })).toBeInTheDocument();
      expect(getDisplayMedia).toHaveBeenCalledTimes(1);
    });

    it('Esc drops the selection first, keeping the tint; typing in the panel still never captures', async () => {
      await openPanel();
      press(tint(), [100, 50], [300, 150]);
      await userEvent.keyboard('{Escape}');
      expect(document.querySelector('[data-shipcue-handle]')).toBeNull();
      expect(tint()).not.toBeNull();
      expect(screen.getByRole('dialog', { name: 'Report a bug' })).toBeInTheDocument();
      press(tint(), [100, 50], [300, 150]);
      await userEvent.click(screen.getByRole('textbox', { name: 'Description' }));
      await userEvent.keyboard('typed{Enter}');
      expect(getDisplayMedia).not.toHaveBeenCalled();
    });
  });
});

describe('dimOnOpen', () => {
  it('tints the page while the panel is open, without blocking it', async () => {
    await openPanel({ dimOnOpen: true, captureOnOpen: false });
    const dim = document.querySelector('[data-shipcue-dim]');
    expect(dim).toHaveStyle({ pointerEvents: 'none', position: 'fixed' });
    await userEvent.keyboard('{Escape}');
    expect(document.querySelector('[data-shipcue-dim]')).toBeNull();
  });

  it('is off by default', async () => {
    await openPanel({ captureOnOpen: false });
    expect(document.querySelector('[data-shipcue-dim]')).toBeNull();
  });

  it('shows under a lifted capture tint, so the page stays tinted but usable', async () => {
    await openPanel({ dimOnOpen: true });
    expect(document.querySelector('[data-shipcue-dim]')).toBeNull();
    await userEvent.keyboard('{Escape}');
    expect(document.querySelector('[data-shipcue-capture]')).toBeNull();
    expect(document.querySelector('[data-shipcue-dim]')).toHaveStyle({ pointerEvents: 'none' });
  });
});

describe('alt text elsewhere', () => {
  it('the Lightbox shows a screenshot by its own alt text', () => {
    render(<Lightbox images={['/s/0#alt=A%20broken%20chart']} index={0} onClose={() => undefined} />);
    expect(screen.getByAltText('A broken chart')).toBeInTheDocument();
  });

  it('captureArea rejects as Unsupported without getDisplayMedia', async () => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {} });
    await expect(captureArea({ x: 0, y: 0, width: 10, height: 10 })).rejects.toMatchObject({ name: 'Unsupported' });
  });
});
