'use client';

// Select an area of the page and capture it as a screenshot (shipcue report 58b727d9).
// The pixels come from the browser's own tab capture (getDisplayMedia, as video.ts uses for
// recordings): one frame, tracks stopped at once, cropped to the selection. Exact, unlike
// re-drawing the DOM, and with no new dependency.

export interface Point {
  x: number;
  y: number;
}
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The rectangle between where a drag started and where it is now, kept inside the viewport. */
export function rectFrom(a: Point, b: Point, viewport: { width: number; height: number }): Rect {
  const clampX = (v: number) => Math.min(Math.max(v, 0), viewport.width);
  const clampY = (v: number) => Math.min(Math.max(v, 0), viewport.height);
  const x1 = clampX(Math.min(a.x, b.x));
  const y1 = clampY(Math.min(a.y, b.y));
  const x2 = clampX(Math.max(a.x, b.x));
  const y2 = clampY(Math.max(a.y, b.y));
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/**
 * Where a selection (CSS px, relative to the viewport) lands in a captured frame. The scale is
 * measured from the frame itself (frame width / viewport width): devicePixelRatio when the tab
 * is captured at its own size, and still right when the browser scales the capture. Both axes
 * use it, since a capture keeps its aspect ratio and a "sharing this tab" bar that appears
 * meanwhile only trims the bottom of the frame. Rounded out to whole pixels, inside the frame.
 */
export function cropRect(sel: Rect, frame: { width: number; height: number }, viewport: { width: number; height: number }, dpr = 1): Rect {
  const sx = viewport.width > 0 && frame.width > 0 ? frame.width / viewport.width : dpr;
  const sy = sx;
  const x = Math.max(0, Math.floor(sel.x * sx));
  const y = Math.max(0, Math.floor(sel.y * sy));
  const right = Math.min(frame.width, Math.ceil((sel.x + sel.width) * sx));
  const bottom = Math.min(frame.height, Math.ceil((sel.y + sel.height) * sy));
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

/** Too small to be a selection: a click, not a drag. */
export const isTiny = (r: Rect, min: number) => r.width < min || r.height < min;

export function canCaptureTab(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function';
}

export type CaptureProblem = 'declined' | 'unsupported' | 'failed';

/** Why a capture failed; null when the person just cancelled the share prompt. */
export function captureError(error: unknown): CaptureProblem | null {
  const name = error && typeof error === 'object' && 'name' in error ? String((error as { name: unknown }).name) : '';
  if (name === 'AbortError') return null;
  if (name === 'NotAllowedError') return 'declined';
  if (name === 'Unsupported' || name === 'NotSupportedError') return 'unsupported';
  return 'failed';
}

const nextFrame = () => new Promise<void>((resolve) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => resolve()) : setTimeout(resolve, 16)));

/** Wait until the page has painted without the tint and the panel. */
export async function afterPaint(frames = 2): Promise<void> {
  for (let i = 0; i < frames; i++) await nextFrame();
}

/**
 * Capture this tab once and crop it to `sel` (CSS px in the viewport). Resolves to a PNG blob.
 * Rejects with the browser's error (NotAllowedError when declined) or { name: 'Unsupported' }.
 */
export async function captureArea(sel: Rect): Promise<Blob> {
  if (!canCaptureTab()) throw Object.assign(new Error('Unsupported'), { name: 'Unsupported' });
  const options = {
    video: { displaySurface: 'browser' },
    audio: false,
    preferCurrentTab: true,
    selfBrowserSurface: 'include',
  } as DisplayMediaStreamOptions;
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const stream = await navigator.mediaDevices.getDisplayMedia(options);
  const stop = () => stream.getTracks().forEach((t) => t.stop());
  try {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    // The first frame can be blank in some browsers: wait for one with a size, then one more.
    for (let i = 0; i < 30 && !video.videoWidth; i++) await nextFrame();
    await nextFrame();
    const frame = { width: video.videoWidth, height: video.videoHeight };
    stop();
    if (!frame.width || !frame.height) throw new Error('No frame');
    const crop = cropRect(sel, frame, viewport, window.devicePixelRatio || 1);
    const canvas = document.createElement('canvas');
    canvas.width = crop.width;
    canvas.height = crop.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No canvas');
    ctx.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
    video.srcObject = null;
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('No image');
    return blob;
  } finally {
    stop();
  }
}
