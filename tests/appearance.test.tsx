// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
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
