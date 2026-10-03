// The annotator's model (shipcue report 58b727d9): a list of marks over the image, an undo and
// a redo stack, and one function that draws them on a 2D canvas. No DOM here beyond the canvas
// context, so it is easy to test.
import type { Point, Rect } from './capture';

export type Tool = 'pen' | 'arrow' | 'rect' | 'highlight' | 'text' | 'blur' | 'crop';
export const TOOLS: Tool[] = ['pen', 'arrow', 'rect', 'highlight', 'text', 'blur', 'crop'];
/** One key per tool, shown in its tooltip. */
export const TOOL_KEY: Record<Tool, string> = { pen: 'P', arrow: 'A', rect: 'R', highlight: 'H', text: 'T', blur: 'B', crop: 'C' };

export type Width = 'S' | 'M' | 'L';
export const WIDTHS: Width[] = ['S', 'M', 'L'];
/** Stroke widths at 1000px of image width; bigger images get thicker lines so they read the same. */
export const WIDTH_PX: Record<Width, number> = { S: 3, M: 6, L: 12 };
export const SWATCHES = ['#e11d48', '#f59e0b', '#16a34a', '#2563eb', '#18181b', '#ffffff'];

export type Mark =
  | { kind: 'pen' | 'highlight'; color: string; width: number; points: Point[] }
  | { kind: 'arrow'; color: string; width: number; from: Point; to: Point }
  | { kind: 'rect'; color: string; width: number; rect: Rect }
  | { kind: 'text'; color: string; size: number; at: Point; text: string }
  | { kind: 'blur'; rect: Rect }
  | { kind: 'crop'; rect: Rect }
  | { kind: 'clear' };

export interface History {
  done: Mark[];
  undone: Mark[];
}
export const emptyHistory = (): History => ({ done: [], undone: [] });

/** A new mark: it can be undone, and anything undone before it is gone. */
export function push(h: History, m: Mark): History {
  return { done: [...h.done, m], undone: [] };
}
export function undo(h: History): History {
  const last = h.done[h.done.length - 1];
  return last ? { done: h.done.slice(0, -1), undone: [...h.undone, last] } : h;
}
export function redo(h: History): History {
  const next = h.undone[h.undone.length - 1];
  return next ? { done: [...h.done, next], undone: h.undone.slice(0, -1) } : h;
}
/** Clear is a mark too, so it can be undone. */
export function clear(h: History): History {
  return live(h.done).length ? push(h, { kind: 'clear' }) : h;
}

/** The marks that show: those after the last Clear. */
export function live(done: Mark[]): Mark[] {
  let from = 0;
  done.forEach((m, i) => m.kind === 'clear' && (from = i + 1));
  return done.slice(from);
}

/** The visible part of the image: the last crop, else all of it. Crops are in image pixels. */
export function viewOf(done: Mark[], image: { width: number; height: number }): Rect {
  const crops = live(done).filter((m): m is Extract<Mark, { kind: 'crop' }> => m.kind === 'crop');
  return crops[crops.length - 1]?.rect ?? { x: 0, y: 0, width: image.width, height: image.height };
}

/** A rectangle from two corners, any direction. */
export function between(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
}

/** Line width in image pixels for a size, scaled to the image. */
export function strokeFor(width: Width, imageWidth: number): number {
  return Math.max(1, Math.round((WIDTH_PX[width] * Math.max(imageWidth, 400)) / 1000));
}

type Ctx = Pick<
  CanvasRenderingContext2D,
  'save' | 'restore' | 'beginPath' | 'moveTo' | 'lineTo' | 'stroke' | 'fill' | 'strokeRect' | 'clearRect' | 'drawImage' | 'fillText' | 'translate' | 'closePath'
> & {
  strokeStyle: CanvasRenderingContext2D['strokeStyle'];
  fillStyle: CanvasRenderingContext2D['fillStyle'];
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  globalAlpha: number;
  font: string;
  textBaseline: CanvasTextBaseline;
  imageSmoothingEnabled: boolean;
  canvas: { width: number; height: number };
};

/**
 * Draw the image and its marks. The canvas is the size of the view (the crop); everything is
 * drawn in image pixels, shifted by the view's corner. `pixelate` makes a small canvas for Blur.
 */
export function render(ctx: Ctx, image: CanvasImageSource & { width: number; height: number }, done: Mark[], extra: Mark | null, pixelate: (w: number, h: number) => { ctx: Ctx; canvas: CanvasImageSource } | null) {
  const marks = [...live(done), ...(extra ? [extra] : [])];
  const view = viewOf(done, image);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.save();
  ctx.translate(-view.x, -view.y);
  ctx.drawImage(image, 0, 0);
  for (const m of marks) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (m.kind === 'pen' || m.kind === 'highlight') {
      ctx.strokeStyle = m.color;
      ctx.lineWidth = m.kind === 'highlight' ? m.width * 3 : m.width;
      if (m.kind === 'highlight') ctx.globalAlpha = 0.35;
      ctx.beginPath();
      m.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      if (m.points.length === 1) ctx.lineTo(m.points[0]!.x + 0.1, m.points[0]!.y);
      ctx.stroke();
    } else if (m.kind === 'arrow') {
      const { from, to } = m;
      const angle = Math.atan2(to.y - from.y, to.x - from.x);
      const head = m.width * 4;
      ctx.strokeStyle = m.color;
      ctx.fillStyle = m.color;
      ctx.lineWidth = m.width;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x - Math.cos(angle) * head * 0.8, to.y - Math.sin(angle) * head * 0.8);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(to.x, to.y);
      ctx.lineTo(to.x - head * Math.cos(angle - Math.PI / 7), to.y - head * Math.sin(angle - Math.PI / 7));
      ctx.lineTo(to.x - head * Math.cos(angle + Math.PI / 7), to.y - head * Math.sin(angle + Math.PI / 7));
      ctx.closePath();
      ctx.fill();
    } else if (m.kind === 'rect') {
      ctx.strokeStyle = m.color;
      ctx.lineWidth = m.width;
      ctx.strokeRect(m.rect.x, m.rect.y, m.rect.width, m.rect.height);
    } else if (m.kind === 'text') {
      ctx.fillStyle = m.color;
      ctx.font = `600 ${m.size}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
      ctx.textBaseline = 'top';
      m.text.split('\n').forEach((line, i) => ctx.fillText(line, m.at.x, m.at.y + i * m.size * 1.25));
    } else if (m.kind === 'blur') {
      // Pixelated, not blurred: a blur can sometimes be read back, big blocks cannot.
      const r = m.rect;
      const block = Math.max(6, Math.round(Math.max(image.width, image.height) / 120));
      const w = Math.max(1, Math.ceil(r.width / block));
      const h = Math.max(1, Math.ceil(r.height / block));
      const small = r.width >= 1 && r.height >= 1 ? pixelate(w, h) : null;
      if (small) {
        small.ctx.drawImage(ctx.canvas as unknown as CanvasImageSource, r.x - view.x, r.y - view.y, r.width, r.height, 0, 0, w, h);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(small.canvas, 0, 0, w, h, r.x, r.y, r.width, r.height);
      }
    } else if (m.kind === 'crop' && m === extra) {
      // While dragging a crop, show it as a dashed outline.
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.max(1, image.width / 500);
      ctx.strokeRect(m.rect.x, m.rect.y, m.rect.width, m.rect.height);
    }
    ctx.restore();
  }
  ctx.restore();
}
