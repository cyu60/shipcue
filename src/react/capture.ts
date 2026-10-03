'use client';

// Select an area of the page and capture it as a screenshot (shipcue report 58b727d9).
// The pixels come from the browser's own tab capture (getDisplayMedia, as video.ts uses for
// recordings): a frame cropped to the selection. The share is kept while the panel is open, so
// the browser asks once (shipcue report 03de1f12). Exact, unlike re-drawing the DOM, and with
// no new dependency.

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
 * How long (ms) a granted tab share is kept for the next capture while the panel stays open
 * (shipcue report 03de1f12), so the browser asks once per session, not per capture. The one
 * default; ReportButton's `captureKeepAlive` overrides it, and 0 stops sharing after each capture.
 */
export const CAPTURE_KEEP_ALIVE_MS = 120_000;

/** Move a selection by (dx, dy), kept whole inside the viewport. */
export function moveRect(r: Rect, dx: number, dy: number, viewport: { width: number; height: number }): Rect {
  const clamp = (v: number, max: number) => Math.min(Math.max(v, 0), Math.max(0, max));
  return { ...r, x: clamp(r.x + dx, viewport.width - r.width), y: clamp(r.y + dy, viewport.height - r.height) };
}

/** A resize handle: corners and edge midpoints, by compass point. */
export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** Drag one handle of a selection by (dx, dy): the opposite side stays put, never under `min`, inside the viewport. */
export function resizeRect(r: Rect, handle: Handle, dx: number, dy: number, viewport: { width: number; height: number }, min: number): Rect {
  let left = r.x;
  let top = r.y;
  let right = r.x + r.width;
  let bottom = r.y + r.height;
  if (handle.includes('w')) left = Math.max(0, Math.min(left + dx, right - min));
  if (handle.includes('e')) right = Math.min(viewport.width, Math.max(right + dx, left + min));
  if (handle.includes('n')) top = Math.max(0, Math.min(top + dy, bottom - min));
  if (handle.includes('s')) bottom = Math.min(viewport.height, Math.max(bottom + dy, top + min));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

const SHARE_OPTIONS = {
  video: { displaySurface: 'browser' },
  audio: false,
  preferCurrentTab: true,
  selfBrowserSurface: 'include',
} as DisplayMediaStreamOptions;

type FrameVideo = HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };

/** The next frame the live track delivers, or a few paints, whichever comes first. */
const nextVideoFrame = (video: FrameVideo) =>
  Promise.race([new Promise<void>((resolve) => (video.requestVideoFrameCallback ? video.requestVideoFrameCallback(() => resolve()) : resolve())), afterPaint(4)]);

export interface TabCapture {
  /** Crop the tab to `sel` (CSS px in the viewport) as a PNG; asks to share only when no live share is held. */
  grab(sel: Rect): Promise<Blob>;
  /** Stop sharing now (the panel closed, the page hid). */
  stop(): void;
}

/**
 * Tab capture that keeps a granted share for later captures (shipcue report 03de1f12): Chrome's
 * "Allow ... to see this tab?" comes up once, not on every capture. Each grab draws the latest
 * frame of the live track; a share that ended ("Stop sharing") is noticed and asked for again.
 * Sharing stops `keepAliveMs` after the last grab (0: at once), or on stop().
 */
export function tabCapture({ keepAliveMs = CAPTURE_KEEP_ALIVE_MS }: { keepAliveMs?: number } = {}): TabCapture {
  let stream: MediaStream | null = null;
  let video: FrameVideo | null = null;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    clearTimeout(idle);
    stream?.getTracks().forEach((t) => t.stop());
    if (video) video.srcObject = null;
    stream = null;
    video = null;
  };
  const live = () => !!stream && stream.getVideoTracks().some((t) => t.readyState !== 'ended');
  const grab = async (sel: Rect): Promise<Blob> => {
    if (!canCaptureTab()) throw Object.assign(new Error('Unsupported'), { name: 'Unsupported' });
    clearTimeout(idle);
    try {
      if (!live()) {
        stop();
        stream = await navigator.mediaDevices.getDisplayMedia(SHARE_OPTIONS);
        video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.srcObject = stream;
        await video.play();
        // The first frame can be blank in some browsers: wait for one with a size, then one more.
        for (let i = 0; i < 30 && !video.videoWidth; i++) await nextFrame();
        await nextFrame();
      } else {
        // A held share: the page has just repainted without the tint and the panel, so take a
        // frame from after that.
        await video!.play();
        await nextVideoFrame(video!);
        await nextVideoFrame(video!);
      }
      const v = video!;
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const frame = { width: v.videoWidth, height: v.videoHeight };
      if (!frame.width || !frame.height) throw new Error('No frame');
      const crop = cropRect(sel, frame, viewport, window.devicePixelRatio || 1);
      const canvas = document.createElement('canvas');
      canvas.width = crop.width;
      canvas.height = crop.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('No canvas');
      ctx.drawImage(v, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('No image');
      return blob;
    } catch (e) {
      stop();
      throw e;
    } finally {
      if (stream) {
        if (keepAliveMs > 0) idle = setTimeout(stop, keepAliveMs);
        else stop();
      }
    }
  };
  return { grab, stop };
}

/**
 * Capture this tab once and crop it to `sel` (CSS px in the viewport). Resolves to a PNG blob.
 * Rejects with the browser's error (NotAllowedError when declined) or { name: 'Unsupported' }.
 * Sharing stops at once; tabCapture() keeps it for the next capture.
 */
export function captureArea(sel: Rect): Promise<Blob> {
  return tabCapture({ keepAliveMs: 0 }).grab(sel);
}
