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

describe('drag the panel (report 76015f97)', () => {
  it('moves by its title, stays where it is left, and Reset puts it back', async () => {
    render(<ReportButton endpoint="/api/shipcue" />);
    fireEvent.click(fab());
    const dialog = await screen.findByRole('dialog');
    // jsdom has no layout: a 384×500 panel at (800, 380) in a 1200×900 window, moved by its transform.
    Object.assign(window, { innerWidth: 1200, innerHeight: 900 });
    dialog.getBoundingClientRect = () => {
      const m = /translate\((-?\d+)px, (-?\d+)px\)/.exec(dialog.style.transform);
      const x = 800 + Number(m?.[1] ?? 0);
      const y = 380 + Number(m?.[2] ?? 0);
      return { left: x, top: y, width: 384, height: 500, right: x + 384, bottom: y + 500, x, y, toJSON: () => ({}) } as DOMRect;
    };
    const handle = screen.getByTitle('Drag to move');
    fireEvent.pointerDown(handle, { button: 0, clientX: 300, clientY: 300, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 200, clientY: 250, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 200, clientY: 250, pointerId: 1 });
    expect(dialog.style.transform).toBe('translate(-100px, -50px)');
    expect(JSON.parse(localStorage.getItem('shipcue:panel-offset')!)).toEqual({ x: -100, y: -50 });
    // Dragged far off the right edge, it is pulled back on screen.
    fireEvent.pointerDown(handle, { button: 0, clientX: 300, clientY: 300, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 2300, clientY: 300, pointerId: 1 });
    expect(dialog.style.transform).toBe('translate(8px, -50px)');
    // Pressing a button in the title (Close) never starts a drag.
    fireEvent.click(screen.getByRole('button', { name: 'Display' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset position' }));
    expect(dialog.style.transform).toBe('');
    expect(localStorage.getItem('shipcue:panel-offset')).toBeNull();
  });

  it('movable={false} keeps the panel still', async () => {
    render(<ReportButton endpoint="/api/shipcue" movable={false} />);
    fireEvent.click(fab());
    await screen.findByRole('dialog');
    expect(screen.queryByTitle('Drag to move')).toBeNull();
  });
});
