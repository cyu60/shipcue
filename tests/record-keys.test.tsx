// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReportButton, DEFAULT_TEXT, type DescriptionEditorProps } from '../src/react';
import { insertAt, keyComboText } from '../src/react/keyText';

const press = (init: Partial<KeyboardEventInit> & { key: string; code: string }) => ({ ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...init });

describe('keyComboText (report 2532c428)', () => {
  it('uses symbols on a Mac', () => {
    expect(keyComboText(press({ key: 'Enter', code: 'Enter', metaKey: true }), true)).toBe('⌘ + Enter');
    expect(keyComboText(press({ key: 'D', code: 'KeyD', ctrlKey: true, shiftKey: true }), true)).toBe('⌃ + ⇧ + D');
    expect(keyComboText(press({ key: 'å', code: 'KeyA', altKey: true, metaKey: true }), true)).toBe('⌥ + ⌘ + A');
    expect(keyComboText(press({ key: '?', code: 'Slash', shiftKey: true, metaKey: true }), true)).toBe('⇧ + ⌘ + /');
  });

  it('uses words elsewhere', () => {
    expect(keyComboText(press({ key: 'Enter', code: 'Enter', ctrlKey: true }), false)).toBe('Ctrl + Enter');
    expect(keyComboText(press({ key: 'D', code: 'KeyD', ctrlKey: true, shiftKey: true }), false)).toBe('Ctrl + Shift + D');
    expect(keyComboText(press({ key: '1', code: 'Digit1', altKey: true }), false)).toBe('Alt + 1');
  });

  it('names keys plainly and waits on a lone modifier', () => {
    expect(keyComboText(press({ key: 'Escape', code: 'Escape', shiftKey: true }), false)).toBe('Shift + Esc');
    expect(keyComboText(press({ key: 'ArrowUp', code: 'ArrowUp' }), true)).toBe('↑');
    expect(keyComboText(press({ key: ' ', code: 'Space', ctrlKey: true }), false)).toBe('Ctrl + Space');
    expect(keyComboText(press({ key: 'F5', code: 'F5' }), false)).toBe('F5');
    expect(keyComboText(press({ key: 'Meta', code: 'MetaLeft', metaKey: true }), true)).toBeNull();
    expect(keyComboText(press({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }), false)).toBeNull();
  });
});

describe('insertAt', () => {
  it('inserts at the caret, spaced from the words around it', () => {
    expect(insertAt('Press  to send', 6, 6, '⌘ + Enter')).toEqual({ text: 'Press ⌘ + Enter to send', caret: 15 });
    expect(insertAt('Pressto send', 5, 5, '⌘ + Enter')).toEqual({ text: 'Press ⌘ + Enter to send', caret: 15 });
    expect(insertAt('', 0, 0, 'Esc')).toEqual({ text: 'Esc', caret: 3 });
    expect(insertAt('Press X now', 6, 7, '⌘ + K')).toEqual({ text: 'Press ⌘ + K now', caret: 11 });
  });
});

describe('the Keys button (report 2532c428)', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
    URL.createObjectURL = vi.fn(() => 'blob:preview');
    URL.revokeObjectURL = vi.fn();
  });
  afterEach(cleanup);

  async function openPanel(props: Partial<Parameters<typeof ReportButton>[0]> = {}) {
    const submit = vi.fn(async (_f: FormData) => ({ id: 'r1' }) as { id: string } | { error: string });
    render(<ReportButton areas={[]} submit={submit} {...props} />);
    await userEvent.click(screen.getByRole('button', { name: DEFAULT_TEXT.openButton }));
    return submit;
  }
  const keysButton = () => screen.getByRole('button', { name: /^(Keys|Press keys)/ });
  const box = () => screen.getByRole('textbox', { name: 'Description' }) as HTMLTextAreaElement;

  it('writes the combination at the caret, then several in a row, until clicked again', async () => {
    await openPanel();
    await userEvent.type(box(), 'Press  to send');
    box().setSelectionRange(6, 6);
    expect(keysButton()).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(keysButton());
    expect(keysButton()).toHaveAttribute('aria-pressed', 'true');
    expect(keysButton()).toHaveTextContent('Press keys… (Esc to stop)');
    fireEvent.keyDown(window, { key: 'Meta', code: 'MetaLeft', metaKey: true });
    fireEvent.keyDown(window, { key: 'Enter', code: 'Enter', metaKey: true });
    expect(box()).toHaveValue('Press ⌘ + Enter to send');
    expect(box().selectionStart).toBe(15);
    fireEvent.keyDown(window, { key: 'K', code: 'KeyK', ctrlKey: true, shiftKey: true });
    expect(box()).toHaveValue('Press ⌘ + Enter ⌃ + ⇧ + K to send');
    await userEvent.click(keysButton());
    expect(keysButton()).toHaveAttribute('aria-pressed', 'false');
    expect(keysButton()).toHaveTextContent('Keys');
  });

  it('stops on Esc, keeps the panel open, and writes nothing for it', async () => {
    await openPanel();
    await userEvent.click(keysButton());
    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' });
    expect(keysButton()).toHaveAttribute('aria-pressed', 'false');
    expect(box()).toHaveValue('');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('stops on Esc after recording some, keeping what was written', async () => {
    await openPanel();
    await userEvent.click(keysButton());
    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape', shiftKey: true });
    expect(box()).toHaveValue('⇧ + Esc');
    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' });
    expect(keysButton()).toHaveAttribute('aria-pressed', 'false');
    expect(box()).toHaveValue('⇧ + Esc');
  });

  it('is a button the keyboard can start', async () => {
    await openPanel();
    keysButton().focus();
    await userEvent.keyboard('{Enter}');
    expect(keysButton()).toHaveAttribute('aria-pressed', 'true');
  });

  it('writes shipcue’s own hotkeys and ⌘↵ as text instead of running them', async () => {
    const submit = await openPanel();
    await userEvent.type(box(), 'Hi');
    await userEvent.click(keysButton());
    // ⌘J would switch to a fresh Agent task, ⌃B to Bug, ⌃F to Feature request, ⌘↵ would send.
    fireEvent.keyDown(window, { key: 'f', code: 'KeyF', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'j', code: 'KeyJ', metaKey: true });
    fireEvent.keyDown(box(), { key: 'Enter', code: 'Enter', metaKey: true });
    expect(box()).toHaveValue('Hi ⌃ + F ⌘ + J ⌘ + Enter');
    expect(screen.getByRole('radio', { name: 'Bug' })).toHaveAttribute('aria-checked', 'true');
    expect(submit).not.toHaveBeenCalled();
    // Once stopped, the hotkeys work again.
    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' });
    fireEvent.keyDown(window, { key: 'f', code: 'KeyF', ctrlKey: true });
    expect(screen.getByRole('radio', { name: 'Feature request' })).toHaveAttribute('aria-checked', 'true');
  });

  it('writes into the app’s own editor (renderDescription) through onChange', async () => {
    function Editor(p: DescriptionEditorProps) {
      const [, force] = useState(0);
      return <input aria-label="My editor" value={p.value} onChange={(e) => (p.onChange(e.target.value), force((n) => n + 1))} />;
    }
    await openPanel({ renderDescription: (p) => <Editor {...p} /> });
    await userEvent.type(screen.getByLabelText('My editor'), 'Send with');
    await userEvent.click(keysButton());
    fireEvent.keyDown(window, { key: 'Enter', code: 'Enter', metaKey: true });
    expect(screen.getByLabelText('My editor')).toHaveValue('Send with ⌘ + Enter');
  });
});
