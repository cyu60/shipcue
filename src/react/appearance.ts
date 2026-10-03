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

// The panel's own size, dragged by its free corner (shipcue report ee970b18). Kept per browser
// in CSS px before the textSize zoom; the extra height goes to the text box. Reset position
// forgets it.

/** The resize grip's hit area (px; bigger on touch) and the arrow-key steps (CSS px). */
export const RESIZE = { grip: 22, gripTouch: 32, step: 8, bigStep: 48 } as const;

export interface PanelSize {
  width: number;
  height: number;
}

const SIZE_KEY = 'shipcue:panel-size';
const isLength = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

export function loadPanelSize(): PanelSize | null {
  try {
    const raw = JSON.parse(localStorage.getItem(SIZE_KEY) ?? 'null') as Record<string, unknown> | null;
    return raw && isLength(raw.width) && isLength(raw.height) ? { width: raw.width, height: raw.height } : null;
  } catch {
    return null;
  }
}

export function savePanelSize(size: PanelSize | null): void {
  try {
    if (size) localStorage.setItem(SIZE_KEY, JSON.stringify(size));
    else localStorage.removeItem(SIZE_KEY);
  } catch {
    // Storage blocked: the size lasts until the page reloads.
  }
}
