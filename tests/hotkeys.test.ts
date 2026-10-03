import { describe, it, expect } from 'vitest';
import { chordOf, normalize, display, defaultHotkeys } from '../src/react/hotkeys';

const ev = (code: string, key: string, mods: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {}) => ({
  code, key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods,
});

describe('hotkeys', () => {
  it('reads letters from the physical key, modifiers in a fixed order', () => {
    expect(chordOf(ev('KeyJ', 'j', { metaKey: true }))).toBe('Cmd+J');
    expect(chordOf(ev('KeyB', '∫', { altKey: true, shiftKey: true }))).toBe('Alt+Shift+B');
    expect(chordOf(ev('ShiftLeft', 'Shift', { shiftKey: true }))).toBeNull();
  });

  it('makes Mod concrete per platform and shows Mac symbols', () => {
    expect(normalize('Mod+J', true)).toBe('Cmd+J');
    expect(normalize('Mod+J', false)).toBe('Ctrl+J');
    expect(display('Mod+J', true)).toBe('⌘J');
    expect(display('Ctrl+B', true)).toBe('⌃B');
    expect(display('Alt+Shift+F', false)).toBe('Alt+Shift+F');
  });

  it("matches the outliner on a Mac and stays off the browser's keys elsewhere", () => {
    expect(defaultHotkeys(true)).toEqual({ task: ['Mod+J'], bug: ['Ctrl+B'], feature: ['Ctrl+F'], dictate: ['Ctrl+M'] });
    expect(defaultHotkeys(false)).toEqual({ task: ['Alt+Shift+J'], bug: ['Alt+Shift+B'], feature: ['Alt+Shift+F'], dictate: ['Alt+Shift+M'] });
  });
});
