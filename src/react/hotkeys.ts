// Keyboard shortcuts for the report button, read the same way as Block Outliner's keymap:
// "Mod" is Cmd on a Mac and Ctrl elsewhere, and letters come from e.code so Shift or a
// Mac's Alt does not change what was pressed.
import type { ReportType } from '../core';

/** Chords per tab: a report type, or the id of one of your extraTabs. */
export type Hotkeys = Partial<Record<ReportType, string[]>> & Record<string, string[] | undefined>;
type KeyInfo = Pick<KeyboardEvent, 'code' | 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>;

const MODS = ['Ctrl', 'Alt', 'Shift', 'Cmd'];

export function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

/**
 * On a Mac: ⌘J for an agent task, ⌃B for a bug, ⌃F for a feature request (as in Block Outliner).
 * Elsewhere Ctrl+J, Ctrl+B and Ctrl+F belong to the browser and to editors, so Alt+Shift.
 */
export function defaultHotkeys(mac = isMac()): Required<Hotkeys> & { dictate: string[]; resetPosition: string[]; selectArea: string[] } {
  // dictate: speak into the report (shipcue report 77a47290). resetPosition: put a dragged
  // button back in its corner (shipcue report 57a7cb45). selectArea: drag out part of the page
  // as a screenshot (shipcue report 58b727d9); ⌃⇧A is free on a Mac (the browsers' own are ⌘⇧A),
  // and Alt+Shift+A elsewhere stays off Ctrl, which the browser owns.
  return mac
    ? { task: ['Mod+J'], bug: ['Ctrl+B'], feature: ['Ctrl+F'], dictate: ['Ctrl+M'], resetPosition: ['Ctrl+Shift+H'], selectArea: ['Ctrl+Shift+A'] }
    : { task: ['Alt+Shift+J'], bug: ['Alt+Shift+B'], feature: ['Alt+Shift+F'], dictate: ['Alt+Shift+M'], resetPosition: ['Alt+Shift+H'], selectArea: ['Alt+Shift+A'] };
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
export function hotkeyType(e: KeyInfo, hotkeys: Hotkeys, mac = isMac()): string | null {
  const chord = chordOf(e);
  if (!chord) return null;
  for (const [type, chords] of Object.entries(hotkeys) as [string, string[] | undefined][]) {
    if (chords?.some((c) => normalize(c, mac) === chord)) return type;
  }
  return null;
}

const USER_KEY = 'shipcue:hotkeys';

/** The shortcuts this person set in the panel, kept in this browser. */
export function loadUserHotkeys(): Hotkeys {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(USER_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object') return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (e): e is [string, string[]] => Array.isArray(e[1]) && e[1].every((c) => typeof c === 'string'),
      ),
    );
  } catch {
    return {};
  }
}

export function saveUserHotkeys(keys: Hotkeys): void {
  try {
    if (Object.keys(keys).length) localStorage.setItem(USER_KEY, JSON.stringify(keys));
    else localStorage.removeItem(USER_KEY);
  } catch {
    // Private mode or blocked storage: the change lasts until the page reloads.
  }
}

export const OPEN_EVENT = 'shipcue:open';

export const CLOSE_EVENT = 'shipcue:close';

/** Open the report panel from anywhere in your app, on a report type or one of your extraTabs. */
export function openReport(tab?: ReportType | (string & {})): void {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { type: tab } }));
}

/** Close the report panel from anywhere in your app. */
export function closeReport(): void {
  window.dispatchEvent(new CustomEvent(CLOSE_EVENT));
}
