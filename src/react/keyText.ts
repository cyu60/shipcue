// Keys (shipcue report 2532c428): a key combination written out as text for a report, so
// "⌘ + Enter" does not have to be typed by hand. Symbols on a Mac, words elsewhere.
import { isMac } from './hotkeys';

type KeyInfo = Pick<KeyboardEvent, 'code' | 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>;

const NAMES: Record<string, string> = {
  ' ': 'Space',
  Escape: 'Esc',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
};

// Punctuation by position, so Shift (or a Mac's Option) does not turn "/" into "?" or "÷".
const CODES: Record<string, string> = {
  Slash: '/',
  Backslash: '\\',
  Period: '.',
  Comma: ',',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
  Space: 'Space',
};

/** True for a press of Shift, Ctrl, Alt or Cmd on its own. */
export function isModifierOnly(e: Pick<KeyboardEvent, 'key'>): boolean {
  return /^(Shift|Control|Alt|AltGraph|Meta|OS|Hyper|Super|Fn)$/.test(e.key);
}

/**
 * How a key press reads in a report: "⌘ + Enter", "⌃ + ⇧ + D" on a Mac, "Ctrl + Shift + D"
 * elsewhere, "Esc" alone. Null for a lone modifier, which waits for the key that goes with it.
 */
export function keyComboText(e: KeyInfo, mac = isMac()): string | null {
  if (isModifierOnly(e)) return null;
  let key: string;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
  else if (CODES[e.code]) key = CODES[e.code]!;
  else if (NAMES[e.key]) key = NAMES[e.key]!;
  else key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  const mods = mac
    ? [e.ctrlKey && '⌃', e.altKey && '⌥', e.shiftKey && '⇧', e.metaKey && '⌘']
    : [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Meta'];
  return [...mods.filter(Boolean), key].join(' + ');
}

/**
 * `insert` put into `text` in place of start..end, with a space either side where it would
 * otherwise run into a word. Returns the new text and the caret just after what went in.
 */
export function insertAt(text: string, start: number, end: number, insert: string): { text: string; caret: number } {
  const s = Math.max(0, Math.min(start, text.length));
  const e = Math.max(s, Math.min(end, text.length));
  const before = text.slice(0, s);
  const after = text.slice(e);
  const lead = before && !/\s$/.test(before) ? ' ' : '';
  const trail = after && !/^\s/.test(after) ? ' ' : '';
  const piece = lead + insert + trail;
  return { text: before + piece + after, caret: before.length + lead.length + insert.length };
}
