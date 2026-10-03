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
