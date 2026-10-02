// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ReportButton, DEFAULT_TEXT } from '../src/react';

beforeAll(() => {
  // jsdom has no PointerEvent; a MouseEvent carries the coordinates the hook reads.
  if (!('PointerEvent' in window)) (window as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent = MouseEvent;
  Object.assign(window, { innerWidth: 1000, innerHeight: 800 });
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});
const ok = async () => ({ id: 'r1' });

describe('the floating button can be moved (report 9061b5f6)', () => {
  it('drags to a new spot, keeps it, and the drag does not open the panel', () => {
    render(<ReportButton areas={[]} submit={ok} />);
    const btn = screen.getByRole('button', { name: DEFAULT_TEXT.openButton });
    fireEvent.pointerDown(btn, { button: 0, clientX: 970, clientY: 770 });
    fireEvent.pointerMove(btn, { clientX: 600, clientY: 500 });
    fireEvent.pointerMove(btn, { clientX: 120, clientY: 90 });
    fireEvent.pointerUp(btn, { clientX: 120, clientY: 90 });
    fireEvent.click(btn);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(JSON.parse(localStorage.getItem('shipcue:button-position')!)).toEqual({ x: 120, y: 90 });
    // Top-left: anchored there, with the panel opening below the button.
    const wrap = btn.closest('[data-shipcue]') as HTMLElement;
    expect(wrap.style.left).toBe('96px');
    expect(wrap.style.top).toBe('66px');
    expect(wrap.style.flexDirection).toBe('column-reverse');
    fireEvent.click(btn);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('comes back where it was left', () => {
    localStorage.setItem('shipcue:button-position', JSON.stringify({ x: 500, y: 700 }));
    render(<ReportButton areas={[]} submit={ok} />);
    const wrap = screen.getByRole('button', { name: DEFAULT_TEXT.openButton }).closest('[data-shipcue]') as HTMLElement;
    expect(wrap.style.bottom).toBe('76px');
  });

  it('stays put with movable={false}', () => {
    render(<ReportButton areas={[]} submit={ok} movable={false} />);
    const btn = screen.getByRole('button', { name: DEFAULT_TEXT.openButton });
    fireEvent.pointerDown(btn, { button: 0, clientX: 970, clientY: 770 });
    fireEvent.pointerMove(btn, { clientX: 120, clientY: 90 });
    fireEvent.pointerUp(btn, { clientX: 120, clientY: 90 });
    expect(localStorage.getItem('shipcue:button-position')).toBeNull();
  });
});
