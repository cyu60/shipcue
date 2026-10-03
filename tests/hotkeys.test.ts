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
    expect(defaultHotkeys(true)).toEqual({ task: ['Mod+J'], bug: ['Ctrl+B'], feature: ['Ctrl+F'], dictate: ['Ctrl+M'], resetPosition: ['Ctrl+Shift+H'], selectArea: ['Ctrl+Shift+A'] });
    expect(defaultHotkeys(false)).toEqual({ task: ['Alt+Shift+J'], bug: ['Alt+Shift+B'], feature: ['Alt+Shift+F'], dictate: ['Alt+Shift+M'], resetPosition: ['Alt+Shift+H'], selectArea: ['Alt+Shift+A'] });
  });

  it('gives Select area a chord no other shortcut or the browser uses (shipcue report 58b727d9)', () => {
    // The browser's and the OS's own: copy/paste/undo, find, tabs, address bar, devtools, and
    // macOS's screenshot keys (⌘⇧3/4/5) and Chrome's tab search (⌘⇧A).
    const reserved = ['Mod+C', 'Mod+V', 'Mod+X', 'Mod+Z', 'Mod+A', 'Mod+F', 'Mod+T', 'Mod+W', 'Mod+L', 'Mod+R', 'Mod+S', 'Mod+P', 'Mod+Shift+A', 'Mod+Shift+I', 'Mod+Shift+3', 'Mod+Shift+4', 'Mod+Shift+5', 'Ctrl+Shift+Tab', 'Alt+Shift+S'];
    for (const mac of [true, false]) {
      const keys = defaultHotkeys(mac);
      const all = Object.values(keys).flat().map((c) => normalize(c as string, mac));
      expect(new Set(all).size).toBe(all.length);
      const area = normalize(keys.selectArea[0]!, mac);
      expect(reserved.map((c) => normalize(c, mac))).not.toContain(area);
    }
    expect(display(defaultHotkeys(true).selectArea[0]!, true)).toBe('⌃⇧A');
  });
});
