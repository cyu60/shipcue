// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { ReportButton } from '../src/react';

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 404 }));
});
afterEach(cleanup);

const fab = () => screen.getAllByRole('button').find((b) => b.querySelector('[data-icon="hat"]'))!;

describe('display settings (report 57a7cb45)', () => {
  it('changes the button and text size, and keeps them in this browser', async () => {
    render(<ReportButton endpoint="/api/shipcue" />);
    expect(fab().style.width).toBe('48px');
    fireEvent.click(fab());
    fireEvent.click(await screen.findByRole('button', { name: 'Display' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Button size: large' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Text size: large' }));
    expect(fab().style.width).toBe('58px');
    expect((screen.getByRole('dialog').style as CSSStyleDeclaration & { zoom: string }).zoom).toBe('1.18');
    expect(JSON.parse(localStorage.getItem('shipcue:appearance')!)).toEqual({ buttonSize: 'large', textSize: 'large' });
  });

  it('the app sets the default size', () => {
    render(<ReportButton endpoint="/api/shipcue" buttonSize="small" />);
    expect(fab().style.width).toBe('40px');
  });

  it('a hotkey puts a dragged button back in its corner', () => {
    localStorage.setItem('shipcue:button-position', JSON.stringify({ x: 100, y: 100 }));
    const { container } = render(<ReportButton endpoint="/api/shipcue" />);
    const wrap = container.firstElementChild as HTMLElement;
    expect(wrap.style.left).toBe('76px');
    fireEvent.keyDown(window, { key: 'H', code: 'KeyH', altKey: true, shiftKey: true });
    expect(localStorage.getItem('shipcue:button-position')).toBeNull();
    expect(wrap.style.left).not.toBe('76px');
  });
});

describe('dragging the panel moves the whole widget (reports 76015f97, 30beb674)', () => {
  // jsdom has no layout: a 1200×900 window, the widget (48px button + 8px gap + 500px panel,
  // 384 wide) in its default bottom-right corner, so the button's centre is (1160, 860).
  const openAt = async (props: Partial<Parameters<typeof ReportButton>[0]> = {}) => {
    const { container } = render(<ReportButton endpoint="/api/shipcue" {...props} />);
    fireEvent.click(fab());
    const dialog = await screen.findByRole('dialog');
    Object.assign(window, { innerWidth: 1200, innerHeight: 900 });
    const wrap = container.firstElementChild as HTMLElement;
    wrap.getBoundingClientRect = () => ({ left: 800, top: 328, width: 384, height: 556, right: 1184, bottom: 884, x: 800, y: 328, toJSON: () => ({}) }) as DOMRect;
    return { wrap, dialog };
  };

  it('moves button and panel together by the title, and keeps one position (the button)', async () => {
    localStorage.setItem('shipcue:panel-offset', JSON.stringify({ x: -40, y: 0 }));
    const { wrap, dialog } = await openAt();
    // 0.17's separate panel spot is forgotten.
    expect(localStorage.getItem('shipcue:panel-offset')).toBeNull();
    const handle = screen.getByTitle('Drag to move');
    fireEvent.pointerDown(handle, { button: 0, clientX: 300, clientY: 300, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 200, clientY: 250, pointerId: 1 });
    // Mid-drag the whole widget is translated; the panel itself has no offset of its own.
    expect(wrap.style.transform).toBe('translate(-100px, -50px)');
    expect(dialog.style.transform).toBe('');
    fireEvent.pointerUp(handle, { clientX: 200, clientY: 250, pointerId: 1 });
    // On release the button's spot moves by the same amount and the translate goes.
    expect(JSON.parse(localStorage.getItem('shipcue:button-position')!)).toEqual({ x: 1060, y: 810 });
    expect(wrap.style.transform).toBe('');
    expect(wrap.style.right).toBe('116px');
    expect(wrap.style.bottom).toBe('66px');
    expect(localStorage.getItem('shipcue:panel-offset')).toBeNull();
    // Reset position (Display) puts it all back in the corner.
    fireEvent.click(screen.getByRole('button', { name: 'Display' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset position' }));
    expect(localStorage.getItem('shipcue:button-position')).toBeNull();
    expect(wrap.style.right).not.toBe('116px');
  });

  it('never leaves the screen, and flips to the new quadrant only on release', async () => {
    const { wrap } = await openAt();
    const handle = screen.getByTitle('Drag to move');
    fireEvent.pointerDown(handle, { button: 0, clientX: 600, clientY: 600, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: -5000, clientY: -5000, pointerId: 1 });
    // Held 8px inside the top-left edge; still laid out for the bottom-right corner.
    expect(wrap.style.transform).toBe('translate(-792px, -320px)');
    expect(wrap.style.flexDirection).not.toBe('column-reverse');
    fireEvent.pointerUp(handle, { clientX: -5000, clientY: -5000, pointerId: 1 });
    expect(JSON.parse(localStorage.getItem('shipcue:button-position')!)).toEqual({ x: 368, y: 540 });
    // Left half, bottom half: anchored left, panel above the button.
    expect(wrap.style.left).toBe('344px');
    expect(wrap.style.bottom).toBe('336px');
    expect(wrap.style.flexDirection).toBe('column');
  });

  it('a press on a button in the title (Close) is not a drag', async () => {
    const { wrap } = await openAt();
    const closeBtn = screen.getByRole('button', { name: 'Close' });
    fireEvent.pointerDown(closeBtn, { button: 0, clientX: 300, clientY: 300, pointerId: 1 });
    fireEvent.pointerMove(closeBtn, { clientX: 100, clientY: 100, pointerId: 1 });
    expect(wrap.style.transform).toBe('');
    fireEvent.pointerUp(closeBtn, { clientX: 100, clientY: 100, pointerId: 1 });
    expect(localStorage.getItem('shipcue:button-position')).toBeNull();
  });

  it('movable={false} keeps the panel still', async () => {
    render(<ReportButton endpoint="/api/shipcue" movable={false} />);
    fireEvent.click(fab());
    await screen.findByRole('dialog');
    expect(screen.queryByTitle('Drag to move')).toBeNull();
  });
});

describe('resizing the panel by its free corner (report ee970b18)', () => {
  // jsdom has no layout: a 1200×900 window and the panel in the default bottom-right corner, its
  // right edge at 1184 and bottom at 828. Its natural size is 384×500 CSS px; a width or
  // min-height set on it wins, as in a browser, and the whole box scales with the text zoom.
  const SIZE_KEY = 'shipcue:panel-size';
  const px = (v: string) => Number(/([\d.]+)px/.exec(v)?.[1] ?? 0);
  const layout = (dialog: HTMLElement) => {
    dialog.getBoundingClientRect = () => {
      const zoom = Number((dialog.style as CSSStyleDeclaration & { zoom: string }).zoom) || 1;
      const width = (px(dialog.style.width) || 384) * zoom;
      const height = Math.max(px(dialog.style.minHeight), 500) * zoom;
      return { left: 1184 - width, top: 828 - height, width, height, right: 1184, bottom: 828, x: 1184 - width, y: 828 - height, toJSON: () => ({}) } as DOMRect;
    };
  };
  const openPanel = async (props: Partial<Parameters<typeof ReportButton>[0]> = {}) => {
    const view = render(<ReportButton endpoint="/api/shipcue" {...props} />);
    Object.assign(window, { innerWidth: 1200, innerHeight: 900 });
    fireEvent.click(fab());
    const dialog = await screen.findByRole('dialog');
    layout(dialog);
    return { ...view, dialog };
  };
  const grip = () => screen.getByRole('button', { name: /resize/i });
  const dragGrip = (from: [number, number], to: [number, number]) => {
    fireEvent.pointerDown(grip(), { button: 0, clientX: from[0], clientY: from[1], pointerId: 1 });
    fireEvent.pointerMove(grip(), { clientX: to[0], clientY: to[1], pointerId: 1 });
    fireEvent.pointerUp(grip(), { clientX: to[0], clientY: to[1], pointerId: 1 });
  };

  it('the grip sits on the corner away from the button, and dragging it grows the panel and its text box', async () => {
    const { dialog } = await openPanel();
    // Panel above and left of a bottom-right button: the free corner is the top-left one.
    expect(grip().style.top).not.toBe('');
    expect(grip().style.left).not.toBe('');
    expect(grip().style.cursor).toBe('nwse-resize');
    dragGrip([816, 328], [716, 228]);
    expect(dialog.style.width).toBe('484px');
    expect(px(dialog.style.minHeight)).toBe(600);
    // The form is a column and the text box takes the extra height.
    const textarea = screen.getByRole('textbox', { name: 'Description' });
    expect(textarea.style.flexGrow).toBe('1');
    expect(JSON.parse(localStorage.getItem(SIZE_KEY)!)).toEqual({ width: 484, height: 600 });
  });

  it('never smaller than the default, never off the screen', async () => {
    const { dialog } = await openPanel();
    dragGrip([816, 328], [1100, 800]);
    expect(JSON.parse(localStorage.getItem(SIZE_KEY)!)).toEqual({ width: 384, height: 500 });
    dragGrip([816, 328], [-5000, -5000]);
    // Held 8px inside the left and top edges of the window.
    expect(dialog.style.width).toBe('1176px');
    expect(px(dialog.style.minHeight)).toBe(820);
  });

  it('is kept in this browser and comes back on reload', async () => {
    const first = await openPanel();
    dragGrip([816, 328], [716, 228]);
    first.unmount();
    const { dialog } = await openPanel();
    expect(dialog.style.width).toBe('484px');
    expect(px(dialog.style.minHeight)).toBe(600);
  });

  it('keeps working with the text zoom (sizes are CSS px before it)', async () => {
    localStorage.setItem('shipcue:appearance', JSON.stringify({ textSize: 'large' }));
    const { dialog } = await openPanel();
    expect((dialog.style as CSSStyleDeclaration & { zoom: string }).zoom).toBe('1.18');
    dragGrip([700, 238], [582, 120]);
    expect(dialog.style.width).toBe('484px');
    expect(px(dialog.style.minHeight)).toBe(600);
  });

  it('arrow keys on the focused grip resize it, Shift for bigger steps', async () => {
    const { dialog } = await openPanel();
    grip().focus();
    fireEvent.keyDown(grip(), { key: 'ArrowUp' });
    expect(px(dialog.style.minHeight)).toBe(508);
    fireEvent.keyDown(grip(), { key: 'ArrowLeft', shiftKey: true });
    expect(dialog.style.width).toBe('432px');
    fireEvent.keyDown(grip(), { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyDown(grip(), { key: 'ArrowRight', shiftKey: true });
    expect(dialog.style.width).toBe('384px');
    expect(JSON.parse(localStorage.getItem(SIZE_KEY)!)).toEqual({ width: 384, height: 508 });
  });

  it('quick key presses each count, before the panel re-renders', async () => {
    const { dialog } = await openPanel();
    // Two presses in one task, as a held key or a script sends them: no render in between.
    act(() => {
      fireEvent.keyDown(grip(), { key: 'ArrowUp', shiftKey: true });
      fireEvent.keyDown(grip(), { key: 'ArrowLeft', shiftKey: true });
    });
    expect(dialog.style.width).toBe('432px');
    expect(JSON.parse(localStorage.getItem(SIZE_KEY)!)).toEqual({ width: 432, height: 548 });
  });

  it('Reset position (hotkey or Display) puts the size back too', async () => {
    const { dialog } = await openPanel();
    dragGrip([816, 328], [716, 228]);
    fireEvent.keyDown(window, { key: 'H', code: 'KeyH', altKey: true, shiftKey: true });
    expect(localStorage.getItem(SIZE_KEY)).toBeNull();
    expect(dialog.style.width).toBe('min(92vw, 24rem)');
    expect(dialog.style.minHeight).toBe('');
    dragGrip([816, 328], [716, 228]);
    fireEvent.click(screen.getByRole('button', { name: 'Display' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset position' }));
    expect(localStorage.getItem(SIZE_KEY)).toBeNull();
    expect(dialog.style.width).toBe('min(92vw, 24rem)');
  });

  it('a grip drag does not move the widget', async () => {
    const { container } = await openPanel();
    dragGrip([816, 328], [716, 228]);
    const wrap = container.firstElementChild as HTMLElement;
    expect(wrap.style.transform).toBe('');
    expect(localStorage.getItem('shipcue:button-position')).toBeNull();
  });

  it('movable={false} still resizes, and Reset position is offered for the size', async () => {
    const { dialog } = await openPanel({ movable: false });
    dragGrip([816, 328], [716, 228]);
    expect(dialog.style.width).toBe('484px');
    fireEvent.click(screen.getByRole('button', { name: 'Display' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset position' }));
    expect(dialog.style.width).toBe('min(92vw, 24rem)');
  });

  it('resizable={false} has no grip', async () => {
    await openPanel({ resizable: false });
    expect(screen.queryByRole('button', { name: /resize/i })).toBeNull();
  });

  it('the inline variant has no grip', async () => {
    render(<ReportButton endpoint="/api/shipcue" variant="inline" />);
    fireEvent.click(screen.getAllByRole('button')[0]!);
    await screen.findByRole('dialog');
    expect(screen.queryByRole('button', { name: /resize/i })).toBeNull();
  });
});

describe('the Send button keeps its size while sending (report 81ff37de)', () => {
  it('never wraps, and holds the width of the longer label in both states', async () => {
    let finish: (v: { id: string }) => void = () => {};
    render(<ReportButton areas={[]} submit={() => new Promise((r) => (finish = r))} />);
    fireEvent.click(fab());
    fireEvent.change(await screen.findByRole('textbox', { name: 'Description' }), { target: { value: 'The heading vanished on Enter' } });
    const button = screen.getByRole('button', { name: /^Send/ });
    expect(button).toHaveStyle({ whiteSpace: 'nowrap', flex: 'none' });
    // Both labels are always there, stacked in one cell; only the visible one is named.
    expect(button).toHaveTextContent('Send');
    expect(button).toHaveTextContent('Sending…');
    fireEvent.click(button);
    const busy = await screen.findByRole('button', { name: /^Sending…/ });
    expect(busy).toBe(button);
    expect(busy).toHaveStyle({ whiteSpace: 'nowrap' });
    finish({ id: 'r-1' });
  });
});
