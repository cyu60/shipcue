'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { Point } from './capture';
import { between, clear, emptyHistory, push, redo, render, strokeFor, SWATCHES, TOOL_KEY, TOOLS, undo, viewOf, WIDTHS, type History, type Mark, type Tool, type Width } from './annotate';
import { DEFAULT_TEXT, type ShipcueText } from './text';

// Mark up a screenshot before it goes into the report, CleanShot style (shipcue report
// 58b727d9): draw, arrow, box, highlight, text, blur and crop, a few colours, three line
// widths, undo/redo (⌘Z / ⇧⌘Z) and clear, plus alt text that is saved with the image.
// "Add to report" flattens it to a PNG. Canvas 2D only; pointer events, so touch draws too.

export interface AnnotatorProps {
  /** The image to mark up: a blob: or data: URL. */
  src: string;
  /** Alt text it already has. */
  alt?: string;
  /** Longest alt text the handler keeps. */
  maxAlt: number;
  /** The flattened PNG and its alt text. */
  onSave: (image: Blob, alt: string) => void;
  onCancel: () => void;
  text?: ShipcueText;
  /** The panel's zoom (textSize), for the toolbar and the alt text field. */
  zoom?: number;
}

type Img = CanvasImageSource & { width: number; height: number };
const TOOL_LABEL = (t: ShipcueText): Record<Tool, string> => ({ pen: t.toolPen, arrow: t.toolArrow, rect: t.toolRect, highlight: t.toolHighlight, text: t.toolText, blur: t.toolBlur, crop: t.toolCrop });
const isTyping = (el: EventTarget | null) => el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);

export function Annotator({ src, alt: startAlt = '', maxAlt, onSave, onCancel, text: t = DEFAULT_TEXT, zoom = 1 }: AnnotatorProps) {
  const [image, setImage] = useState<Img | null>(null);
  const [failed, setFailed] = useState(false);
  const [tool, setTool] = useState<Tool>('arrow');
  const [color, setColor] = useState(SWATCHES[0]!);
  const [width, setWidth] = useState<Width>('M');
  const [history, setHistory] = useState<History>(emptyHistory);
  const [draft, setDraftState] = useState<Mark | null>(null);
  // Also in a ref: pointer events can come faster than renders, and a fast drag must not be
  // read from a stale render (it would end as a click and draw nothing).
  const draftRef = useRef<Mark | null>(null);
  const setDraft = (m: Mark | null) => {
    draftRef.current = m;
    setDraftState(m);
  };
  const [typing, setTyping] = useState<{ at: Point; css: Point; value: string } | null>(null);
  const [alt, setAlt] = useState(startAlt);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const start = useRef<Point | null>(null);

  useEffect(() => {
    let live = true;
    const img = new Image();
    img.onload = () => live && setImage(img);
    img.onerror = () => live && setFailed(true);
    img.src = src;
    return () => {
      live = false;
    };
  }, [src]);

  const view = image ? viewOf(history.done, image) : null;
  // Redraw whenever the marks, the draft or the view change.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image || !view) return;
    if (canvas.width !== view.width) canvas.width = view.width;
    if (canvas.height !== view.height) canvas.height = view.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    render(ctx, image, history.done, draft, (w, h) => {
      const small = document.createElement('canvas');
      small.width = w;
      small.height = h;
      const sctx = small.getContext('2d');
      return sctx ? { ctx: sctx, canvas: small } : null;
    });
  }, [image, history, draft, view?.x, view?.y, view?.width, view?.height]);

  const commitText = () => {
    if (typing && typing.value.trim() && image) {
      setHistory((h) => push(h, { kind: 'text', color, size: Math.round(strokeFor(width, image.width) * 4.5), at: typing.at, text: typing.value }));
    }
    setTyping(null);
  };

  const save = () => {
    const canvas = canvasRef.current;
    if (!canvas || !image) return;
    const ctx = canvas.getContext('2d');
    if (ctx) render(ctx, image, history.done, null, () => null);
    canvas.toBlob((blob) => blob && onSave(blob, alt.trim().slice(0, maxAlt)), 'image/png');
  };

  const keys = useRef({ onCancel, save, commitText });
  keys.current = { onCancel, save, commitText };
  const typingRef = useRef(typing);
  typingRef.current = typing;

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    boxRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (typingRef.current) setTyping(null);
        else keys.current.onCancel();
        return;
      }
      if (mod && e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        keys.current.save();
        return;
      }
      // In the alt text or a text label, keys type (and ⌘Z undoes the typing).
      if (isTyping(e.target)) return;
      if (mod && e.code === 'KeyZ') {
        e.preventDefault();
        e.stopPropagation();
        setHistory((h) => (e.shiftKey ? redo(h) : undo(h)));
        return;
      }
      if (mod && e.code === 'KeyY') {
        e.preventDefault();
        e.stopPropagation();
        setHistory(redo);
        return;
      }
      if (mod || e.altKey) return;
      const picked = TOOLS.find((x) => `Key${TOOL_KEY[x]}` === e.code);
      if (picked) {
        e.preventDefault();
        e.stopPropagation();
        setTool(picked);
      }
    };
    // Capture, like the Lightbox: the panel's Esc and hotkeys must not fire underneath.
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      before?.focus?.();
    };
  }, []);

  /** Where a pointer is, in image pixels (the canvas is scaled to fit the screen). */
  const at = (e: React.PointerEvent): Point => {
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    const sx = r.width ? c.width / r.width : 1;
    const sy = r.height ? c.height / r.height : 1;
    return { x: (e.clientX - r.left) * sx + (view?.x ?? 0), y: (e.clientY - r.top) * sy + (view?.y ?? 0) };
  };
  const line = () => (image ? strokeFor(width, image.width) : 2);

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!image || e.button !== 0) return;
    e.preventDefault();
    const p = at(e);
    if (tool === 'text') {
      if (typing) commitText();
      // The label is typed in place, over the canvas, then drawn into it.
      const box = e.currentTarget.parentElement!.getBoundingClientRect();
      setTyping({ at: p, css: { x: e.clientX - box.left, y: e.clientY - box.top }, value: '' });
      return;
    }
    start.current = p;
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      // An unknown pointer (some synthetic events).
    }
    if (tool === 'pen' || tool === 'highlight') setDraft({ kind: tool, color, width: line(), points: [p] });
    else if (tool === 'arrow') setDraft({ kind: 'arrow', color, width: line(), from: p, to: p });
    else setDraft(tool === 'rect' ? { kind: 'rect', color, width: line(), rect: between(p, p) } : { kind: tool, rect: between(p, p) });
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const s0 = start.current;
    const draft = draftRef.current;
    if (!s0 || !draft) return;
    const p = at(e);
    if (draft.kind === 'pen' || draft.kind === 'highlight') setDraft({ ...draft, points: [...draft.points, p] });
    else if (draft.kind === 'arrow') setDraft({ ...draft, to: p });
    else if (draft.kind === 'rect' || draft.kind === 'blur' || draft.kind === 'crop') setDraft({ ...draft, rect: between(s0, p) });
  };
  const onUp = () => {
    const d = draftRef.current;
    start.current = null;
    setDraft(null);
    if (!d) return;
    // A click with a shape tool makes nothing.
    const tiny = (d.kind === 'rect' || d.kind === 'blur' || d.kind === 'crop') && (d.rect.width < 3 || d.rect.height < 3);
    const dot = d.kind === 'arrow' && Math.hypot(d.to.x - d.from.x, d.to.y - d.from.y) < 3;
    if (tiny || dot) return;
    setHistory((h) => push(h, d));
  };

  const labels = TOOL_LABEL(t);
  return createPortal(
    <div ref={boxRef} role="dialog" aria-modal="true" aria-label={t.annotateTitle} tabIndex={-1} style={s.backdrop}>
      <div style={s.card}>
        <div role="toolbar" aria-label={t.annotateTitle} style={{ ...s.bar, ...(zoom !== 1 ? { zoom } : null) }}>
          <span role="radiogroup" aria-label="Tool" style={s.pills}>
            {TOOLS.map((x) => (
              <button key={x} type="button" role="radio" aria-checked={tool === x} title={`${labels[x]} (${TOOL_KEY[x]})`} onClick={() => setTool(x)} style={tool === x ? s.pillOn : s.pill}>
                {labels[x]}
              </button>
            ))}
          </span>
          <span role="radiogroup" aria-label={t.color} style={s.group}>
            {SWATCHES.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={color === c}
                aria-label={`${t.color} ${c}`}
                onClick={() => setColor(c)}
                style={{ ...s.swatch, background: c, boxShadow: color === c ? '0 0 0 2px #fff, 0 0 0 3.5px #18181b' : 'inset 0 0 0 1px rgba(0,0,0,0.15)' }}
              />
            ))}
          </span>
          <span role="radiogroup" aria-label={t.strokeWidth} style={s.pills}>
            {WIDTHS.map((w) => (
              <button key={w} type="button" role="radio" aria-checked={width === w} aria-label={`${t.strokeWidth} ${w}`} onClick={() => setWidth(w)} style={width === w ? s.pillOn : s.pill}>
                {w}
              </button>
            ))}
          </span>
          <span style={s.group}>
            <button type="button" onClick={() => setHistory(undo)} disabled={!history.done.length} title={`${t.undo} (⌘Z)`} style={s.small}>
              {t.undo}
            </button>
            <button type="button" onClick={() => setHistory(redo)} disabled={!history.undone.length} title={`${t.redo} (⇧⌘Z)`} style={s.small}>
              {t.redo}
            </button>
            <button type="button" onClick={() => setHistory(clear)} style={s.small}>
              {t.clear}
            </button>
          </span>
        </div>

        <div style={s.stage}>
          <div style={{ position: 'relative', lineHeight: 0, maxWidth: '100%' }}>
            {failed ? (
              <p style={{ color: '#fff', fontSize: 12, lineHeight: 1.4 }}>{t.captureFailed}</p>
            ) : (
              <canvas
                ref={canvasRef}
                aria-label={alt || t.annotateTitle}
                role="img"
                onPointerDown={onDown}
                onPointerMove={onMove}
                onPointerUp={onUp}
                onPointerCancel={onUp}
                style={{ ...s.canvas, cursor: tool === 'text' ? 'text' : 'crosshair' }}
              />
            )}
            {typing && (
              <textarea
                autoFocus
                aria-label={labels.text}
                value={typing.value}
                onChange={(e) => setTyping({ ...typing, value: e.target.value })}
                onBlur={commitText}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    commitText();
                  }
                }}
                rows={1}
                style={{ ...s.textInput, left: typing.css.x, top: typing.css.y, color }}
              />
            )}
          </div>
        </div>

        <div style={{ ...s.foot, ...(zoom !== 1 ? { zoom } : null) }}>
          <label style={s.altLabel}>
            <span style={{ flex: 'none' }}>{t.altText}</span>
            <input value={alt} onChange={(e) => setAlt(e.target.value)} maxLength={maxAlt} placeholder={t.altPlaceholder} style={s.altInput} />
          </label>
          <span style={{ display: 'inline-flex', gap: 6, flex: 'none' }}>
            <button type="button" onClick={onCancel} style={s.small}>
              {t.cancel}
            </button>
            <button type="button" onClick={save} disabled={!image} style={s.primary}>
              {t.addToReport}
            </button>
          </span>
        </div>
        {!alt.trim() && <p style={s.hint}>{t.altHint}</p>}
      </div>
    </div>,
    document.body,
  );
}

const font = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
const pill: CSSProperties = { border: 0, borderRadius: 6, padding: '3px 8px', fontSize: 11, fontWeight: 500, fontFamily: font, cursor: 'pointer', background: 'transparent', color: '#71717a', whiteSpace: 'nowrap' };
const s: Record<string, CSSProperties> = {
  backdrop: { position: 'fixed', inset: 0, zIndex: 2147483600, background: 'rgba(9,9,11,0.72)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12, boxSizing: 'border-box', outline: 'none', fontFamily: font },
  card: { display: 'flex', flexDirection: 'column', gap: 8, maxWidth: '100%', maxHeight: '100%', background: '#fff', borderRadius: 12, padding: 10, boxSizing: 'border-box', boxShadow: '0 12px 40px rgba(0,0,0,0.35)' },
  bar: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  pills: { display: 'inline-flex', flexWrap: 'wrap', gap: 2, background: '#f4f4f5', borderRadius: 8, padding: 2 },
  pill,
  pillOn: { ...pill, background: '#fff', color: '#18181b', boxShadow: '0 1px 2px rgba(0,0,0,0.08)' },
  group: { display: 'inline-flex', gap: 6, alignItems: 'center' },
  swatch: { width: 14, height: 14, borderRadius: 999, border: 0, padding: 0, cursor: 'pointer' },
  small: { border: '1px solid #e4e4e7', borderRadius: 6, background: '#fff', color: '#3f3f46', padding: '3px 8px', fontSize: 11, fontFamily: font, cursor: 'pointer' },
  primary: { border: 0, borderRadius: 6, background: '#18181b', color: '#fff', padding: '4px 10px', fontSize: 12, fontWeight: 500, fontFamily: font, cursor: 'pointer' },
  stage: { minHeight: 0, flex: '1 1 auto', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#27272a', borderRadius: 8, padding: 8, overflow: 'auto' },
  canvas: { display: 'block', maxWidth: 'min(1200px, calc(100vw - 56px))', maxHeight: 'calc(100dvh - 190px)', touchAction: 'none', background: '#fff' },
  textInput: { position: 'absolute', minWidth: 120, border: '1px dashed rgba(255,255,255,0.8)', background: 'rgba(0,0,0,0.25)', fontSize: 14, fontWeight: 600, fontFamily: font, lineHeight: 1.3, padding: '2px 4px', resize: 'none', outline: 'none' },
  foot: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'space-between' },
  altLabel: { display: 'flex', alignItems: 'center', gap: 6, flex: '1 1 220px', fontSize: 11, color: '#71717a', fontWeight: 500 },
  altInput: { flex: 1, minWidth: 0, border: '1px solid #d4d4d8', borderRadius: 6, padding: '4px 8px', fontSize: 12, fontFamily: font, color: '#27272a' },
  hint: { margin: 0, fontSize: 10, color: '#a1a1aa' },
};
