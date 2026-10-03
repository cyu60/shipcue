// How big the button and the panel's text are (shipcue report 57a7cb45). The app sets a default
// with the buttonSize and textSize props; each person can change it in the panel's Display
// settings, kept in their browser.

export type Size = 'small' | 'medium' | 'large';
export const SIZES: Size[] = ['small', 'medium', 'large'];

/** The floating button's diameter, in px. */
export const BUTTON_PX: Record<Size, number> = { small: 40, medium: 48, large: 58 };
/** The panel's zoom: every size in it scales together. */
export const TEXT_ZOOM: Record<Size, number> = { small: 0.9, medium: 1, large: 1.18 };

export interface Appearance {
  buttonSize?: Size;
  textSize?: Size;
}

const KEY = 'shipcue:appearance';
const isSize = (v: unknown): v is Size => typeof v === 'string' && (SIZES as string[]).includes(v);

export function loadAppearance(): Appearance {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
    return { ...(isSize(raw.buttonSize) ? { buttonSize: raw.buttonSize } : {}), ...(isSize(raw.textSize) ? { textSize: raw.textSize } : {}) };
  } catch {
    return {};
  }
}

export function saveAppearance(a: Appearance): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(a));
  } catch {
    // Storage blocked: the choice lasts until the page reloads.
  }
}
