// Keyboard shortcuts for the report button, read the same way as Block Outliner's keymap:
// "Mod" is Cmd on a Mac and Ctrl elsewhere, and letters come from e.code so Shift or a
// Mac's Alt does not change what was pressed.
import type { ReportType } from '../core';

export type Hotkeys = Partial<Record<ReportType, string[]>>;
type KeyInfo = Pick<KeyboardEvent, 'code' | 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>;

const MODS = ['Ctrl', 'Alt', 'Shift', 'Cmd'];

export function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

/**
 * On a Mac: ⌘J for an agent task, ⌃B for a bug, ⌃F for a feature request (as in Block Outliner).
 * Elsewhere Ctrl+J, Ctrl+B and Ctrl+F belong to the browser and to editors, so Alt+Shift.
 */
export function defaultHotkeys(mac = isMac()): Required<Hotkeys> {
  return mac
    ? { task: ['Mod+J'], bug: ['Ctrl+B'], feature: ['Ctrl+F'] }
    : { task: ['Alt+Shift+J'], bug: ['Alt+Shift+B'], feature: ['Alt+Shift+F'] };
}

/** The chord a key press is ("Ctrl+B", "Cmd+J"), or null for a lone modifier. */
export function chordOf(e: KeyInfo): string | null {
  if (/^(Shift|Control|Alt|Meta|OS)/.test(e.key)) return null;
  let key: string;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
  else key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Cmd'].filter(Boolean);
  return [...mods, key].join('+');
}

/** "Mod" made concrete for this platform, modifiers in a fixed order. */
export function normalize(chord: string, mac = isMac()): string {
  const parts = chord.split('+');
  const key = parts[parts.length - 1] ?? '';
  const mods = new Set(parts.slice(0, -1).map((m) => (m === 'Mod' ? (mac ? 'Cmd' : 'Ctrl') : m)));
  return [...MODS.filter((m) => mods.has(m)), key.length === 1 ? key.toUpperCase() : key].join('+');
}

/** How a chord reads on screen: ⌘J on a Mac, Alt+Shift+J elsewhere. */
export function display(chord: string, mac = isMac()): string {
  const parts = normalize(chord, mac).split('+');
  const key = parts.pop() ?? '';
  if (!mac) return [...parts, key].join('+');
  const sym: Record<string, string> = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Cmd: '⌘' };
  return parts.map((m) => sym[m]).join('') + key;
}

/** Which tab a key press opens, if any. */
export function hotkeyType(e: KeyInfo, hotkeys: Hotkeys, mac = isMac()): ReportType | null {
  const chord = chordOf(e);
  if (!chord) return null;
  for (const [type, chords] of Object.entries(hotkeys) as [ReportType, string[]][]) {
    if (chords.some((c) => normalize(c, mac) === chord)) return type;
  }
  return null;
}

export const OPEN_EVENT = 'shipcue:open';

/** Open the report panel from anywhere in your app, e.g. a menu item. */
export function openReport(type?: ReportType): void {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { type } }));
}
