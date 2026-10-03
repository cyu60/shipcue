'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { isTiny, rectFrom, type Point, type Rect } from './capture';

// Select an area of the page (shipcue report 58b727d9): a dark tint over everything, a
// crosshair, drag a rectangle (it shows undimmed, with its size), Enter or letting go
// captures it, Esc cancels. Pointer events, so a finger works as well as a mouse. From the
// keyboard: Enter with nothing drawn takes the whole visible page; arrows move the selection
// and Shift+arrows resize it.
//
// `ambient` (shipcue report 503aa011): the same tint and drag, laid under the open report panel
// so a drag anywhere on the page captures with no hotkey or button. It takes no keys and no
// focus (typing in the panel never captures), and a plain click or tap lifts it (onDismiss).

export interface AreaSelectProps {
  onSelect: (rect: Rect) => void;
  onCancel: () => void;
  /** The line at the top, e.g. "Drag to select an area · Enter captures · Esc cancels". */
  hint: string;
  /** Smaller than this (CSS px) on either side is a click, not a selection. */
  minSize?: number;
  /**
   * Under the report panel instead of over everything: no keys, no focus, and a press that moves
   * less than `clickSlop` px calls onDismiss. Esc is the panel's to handle.
   */
  ambient?: boolean;
  /** Ambient only: a click or tap on the tint (no drag). */
  onDismiss?: () => void;
  /** Ambient only: how far (CSS px) a press may move and still be a click. */
  clickSlop?: number;
}

const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });

export function AreaSelect({ onSelect, onCancel, hint, minSize = 8, ambient = false, onDismiss, clickSlop = 5 }: AreaSelectProps) {
  const [rect, setRect] = useState<Rect | null>(null);
  const start = useRef<Point | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const rectRef = useRef(rect);
  rectRef.current = rect;
  const done = useRef({ onSelect, onCancel });
  done.current = { onSelect, onCancel };

  useEffect(() => {
    if (ambient) return;
    const before = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        done.current.onCancel();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        const r = rectRef.current;
        done.current.onSelect(r && !isTiny(r, minSize) ? r : { x: 0, y: 0, ...viewport() });
      } else if (e.key.startsWith('Arrow')) {
        e.preventDefault();
        e.stopPropagation();
        const step = e.altKey ? 1 : 10;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        setRect((r) => {
          const v = viewport();
          const cur = r ?? { x: v.width / 4, y: v.height / 4, width: v.width / 2, height: v.height / 2 };
          const next = e.shiftKey ? { ...cur, width: cur.width + dx, height: cur.height + dy } : { ...cur, x: cur.x + dx, y: cur.y + dy };
          return rectFrom({ x: next.x, y: next.y }, { x: next.x + Math.max(minSize, next.width), y: next.y + Math.max(minSize, next.height) }, v);
        });
      }
    };
    // Capture: the panel's own keys (Esc closes it) and the page's must not fire too.
    window.addEventListener('keydown', onKey, true);
    // The page must not scroll under a selection (it is in viewport pixels). Not passive, so
    // preventDefault holds.
    const el = ref.current;
    const still = (e: Event) => e.preventDefault();
    el?.addEventListener('wheel', still, { passive: false });
    return () => {
      el?.removeEventListener('wheel', still);
      window.removeEventListener('keydown', onKey, true);
      before?.focus?.();
    };
  }, [minSize, ambient]);

  const at = (e: React.PointerEvent): Point => ({ x: e.clientX, y: e.clientY });
  // Ambient: no rectangle until the press has moved past the click slop.
  const moved = (p: Point) => !!start.current && Math.max(Math.abs(p.x - start.current.x), Math.abs(p.y - start.current.y)) >= clickSlop;
  const r = rect;
  const dim = ambient ? 'rgba(9,9,11,0.3)' : 'rgba(9,9,11,0.45)';
  return createPortal(
    <div
      ref={ref}
      {...(ambient ? { 'data-shipcue-capture': '' } : { role: 'dialog', 'aria-modal': 'true' as const, 'aria-label': 'Select an area', tabIndex: -1, 'data-shipcue-select': '' })}
      style={ambient ? { ...s.layer, zIndex: 2147482999 } : s.layer}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        start.current = at(e);
        if (!ambient) setRect({ ...at(e), width: 0, height: 0 });
        try {
          e.currentTarget.setPointerCapture?.(e.pointerId);
        } catch {
          // An unknown pointer (some synthetic events).
        }
      }}
      onPointerMove={(e) => {
        if (!start.current || (ambient && !rectRef.current && !moved(at(e)))) return;
        setRect(rectFrom(start.current, at(e), viewport()));
      }}
      onPointerCancel={() => {
        start.current = null;
        setRect(null);
      }}
      onPointerUp={(e) => {
        if (!start.current) return;
        const next = rectFrom(start.current, at(e), viewport());
        const click = ambient && !rectRef.current && !moved(at(e));
        start.current = null;
        if (click) {
          onDismiss?.();
          return;
        }
        if (isTiny(next, minSize)) {
          setRect(null);
          return;
        }
        setRect(next);
        onSelect(next);
      }}
    >
      {r && r.width > 0 && r.height > 0 ? (
        <>
          {/* Four bands of tint around the selection, so the selection itself shows undimmed. */}
          <div style={{ ...s.band, background: dim, left: 0, top: 0, right: 0, height: r.y }} />
          <div style={{ ...s.band, background: dim, left: 0, top: r.y + r.height, right: 0, bottom: 0 }} />
          <div style={{ ...s.band, background: dim, left: 0, top: r.y, width: r.x, height: r.height }} />
          <div style={{ ...s.band, background: dim, left: r.x + r.width, top: r.y, right: 0, height: r.height }} />
          <div data-shipcue-selection="" style={{ ...s.sel, left: r.x, top: r.y, width: r.width, height: r.height }} />
          <span style={{ ...s.size, left: r.x, top: r.y + r.height + 6 > window.innerHeight - 24 ? Math.max(0, r.y - 24) : r.y + r.height + 6 }}>
            {Math.round(r.width)} × {Math.round(r.height)}
          </span>
        </>
      ) : (
        <div style={{ ...s.band, background: dim, inset: 0 }} />
      )}
      <p {...(ambient ? null : { role: 'status' })} style={ambient ? s.ambientHint : s.hint}>
        {hint}
      </p>
    </div>,
    document.body,
  );
}

const font = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
const s: Record<string, CSSProperties> = {
  layer: { position: 'fixed', inset: 0, zIndex: 2147483600, cursor: 'crosshair', touchAction: 'none', userSelect: 'none', outline: 'none' },
  band: { position: 'absolute', pointerEvents: 'none' },
  sel: { position: 'absolute', boxSizing: 'border-box', border: '1px solid rgba(255,255,255,0.9)', boxShadow: '0 0 0 1px rgba(9,9,11,0.35)', pointerEvents: 'none' },
  size: { position: 'absolute', padding: '2px 6px', borderRadius: 4, background: 'rgba(9,9,11,0.75)', color: '#fff', fontSize: 11, fontFamily: font, pointerEvents: 'none', whiteSpace: 'nowrap' },
  ambientHint: { position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)', margin: 0, padding: '3px 9px', borderRadius: 999, background: 'rgba(9,9,11,0.6)', color: 'rgba(255,255,255,0.9)', fontSize: 11, fontFamily: font, pointerEvents: 'none', whiteSpace: 'nowrap', maxWidth: 'calc(100vw - 32px)', overflow: 'hidden', textOverflow: 'ellipsis' },
  hint: { position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', margin: 0, padding: '4px 10px', borderRadius: 999, background: 'rgba(9,9,11,0.75)', color: '#fff', fontSize: 12, fontFamily: font, pointerEvents: 'none', whiteSpace: 'nowrap' },
};
