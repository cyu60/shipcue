'use client';

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { HANDLES, isTiny, moveRect, rectFrom, resizeRect, type Handle, type Point, type Rect } from './capture';
import { DEFAULT_TEXT, type ShipcueText } from './text';

// Select an area of the page (shipcue report 58b727d9): a dark tint over everything, a
// crosshair, drag a rectangle (it shows undimmed, with its size), Esc cancels. Pointer events, so
// a finger works as well as a mouse. From the keyboard: Enter with nothing drawn takes the whole
// visible page; arrows move the selection (Alt: 1px) and Shift+arrows resize it.
//
// Letting go no longer captures (shipcue report 03de1f12): the selection stays, CleanShot-style,
// to move (drag inside), resize (eight handles, or the size fields) or redraw (drag outside it),
// with a small toolbar: Capture (Enter), Capture & annotate, Cancel (Esc). Nothing is asked of
// the browser until one of the captures.
//
// `ambient` (shipcue report 503aa011): the same tint and drag, laid under the open report panel
// so a drag anywhere on the page selects with no hotkey or button. It takes no keys and no focus
// until a selection is drawn (typing in the panel never captures), and a plain click or tap
// lifts it (onDismiss).

export interface AreaSelectProps {
  /** A capture was asked for: `annotate` when the person chose Capture & annotate. */
  onSelect: (rect: Rect, opts: { annotate: boolean }) => void;
  onCancel: () => void;
  /** The line at the top, e.g. "Drag to select an area · Enter captures · Esc cancels". */
  hint: string;
  /** Labels for the toolbar and the hint once a selection is drawn; shipcue's own by default. */
  text?: ShipcueText;
  /** Smaller than this (CSS px) on either side is a click, not a selection. */
  minSize?: number;
  /**
   * Under the report panel instead of over everything: no keys or focus until a selection is
   * drawn, and a press that moves less than `clickSlop` px calls onDismiss. Esc with no
   * selection is the panel's to handle.
   */
  ambient?: boolean;
  /** Ambient only: a click or tap on the tint (no drag). */
  onDismiss?: () => void;
  /** How far (CSS px) a press may move and still be a click (ambient, and outside a drawn selection). */
  clickSlop?: number;
}

const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });
type Drag = { kind: 'draw' | 'move' | Handle; from: Point; base: Rect | null; live: boolean };
const CURSOR: Record<Handle, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };
const AT: Record<Handle, [string, string]> = { nw: ['0%', '0%'], n: ['50%', '0%'], ne: ['100%', '0%'], e: ['100%', '50%'], se: ['100%', '100%'], s: ['50%', '100%'], sw: ['0%', '100%'], w: ['0%', '50%'] };

export function AreaSelect({ onSelect, onCancel, hint, text: t = DEFAULT_TEXT, minSize = 8, ambient = false, onDismiss, clickSlop = 5 }: AreaSelectProps) {
  const [rect, setRect] = useState<Rect | null>(null);
  // 'adjust': drawn and let go; the selection waits for a capture.
  const [phase, setPhase] = useState<'idle' | 'draw' | 'adjust'>('idle');
  const drag = useRef<Drag | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const rectRef = useRef(rect);
  rectRef.current = rect;
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const done = useRef({ onSelect, onCancel });
  done.current = { onSelect, onCancel };
  // Typed sizes: kept as typed (an empty field while retyping) until the field is left.
  const [draft, setDraft] = useState<{ width?: string; height?: string }>({});
  // Big enough to grab with a finger (the visible square stays small).
  const [hit] = useState(() => (typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches ? 36 : 20));
  const [bar, setBar] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const next = { width: el.offsetWidth, height: el.offsetHeight };
    if (next.width !== bar.width || next.height !== bar.height) setBar(next);
  });

  const adjusting = phase === 'adjust' && !!rect;
  const capture = (annotate: boolean) => {
    const r = rectRef.current;
    if (r && phaseRef.current === 'adjust') done.current.onSelect(r, { annotate });
  };
  const cancel = () => {
    // Ambient: drop the selection and keep the tint; the panel's Esc lifts the tint after that.
    if (ambient) {
      setRect(null);
      setPhase('idle');
      setDraft({});
    } else done.current.onCancel();
  };
  const actions = useRef({ capture, cancel });
  actions.current = { capture, cancel };

  useEffect(() => {
    if (!ambient) ref.current?.focus();
    const before = ambient ? null : (document.activeElement as HTMLElement | null);
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inBar = !!target && !!barRef.current?.contains(target);
      // Ambient: only once a selection is drawn, and never from the panel's own fields.
      if (ambient && (phaseRef.current !== 'adjust' || !(target === document.body || inBar || ref.current?.contains(target)))) return;
      // The toolbar's buttons take Enter and Space themselves.
      if (inBar && target?.tagName === 'BUTTON' && (e.key === 'Enter' || e.key === ' ')) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        actions.current.cancel();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        const r = rectRef.current;
        if (r && phaseRef.current === 'adjust') actions.current.capture(false);
        else if (!ambient) done.current.onSelect({ x: 0, y: 0, ...viewport() }, { annotate: false });
      } else if (e.key.startsWith('Arrow') && target?.tagName !== 'INPUT') {
        e.preventDefault();
        e.stopPropagation();
        const step = e.altKey ? 1 : 10;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        const v = viewport();
        const cur = rectRef.current ?? { x: v.width / 4, y: v.height / 4, width: v.width / 2, height: v.height / 2 };
        setRect(e.shiftKey ? resizeRect(cur, 'se', dx, dy, v, minSize) : moveRect(cur, dx, dy, v));
        setPhase('adjust');
        setDraft({});
      }
    };
    // Capture: the panel's own keys (Esc closes it) and the page's must not fire too.
    window.addEventListener('keydown', onKey, true);
    // The page must not scroll under a selection (it is in viewport pixels). Not passive, so
    // preventDefault holds. Ambient lets the page scroll until a selection is drawn.
    const el = ref.current;
    const still = (e: Event) => {
      if (!ambient || phaseRef.current !== 'idle') e.preventDefault();
    };
    el?.addEventListener('wheel', still, { passive: false });
    return () => {
      el?.removeEventListener('wheel', still);
      window.removeEventListener('keydown', onKey, true);
      before?.focus?.();
    };
  }, [minSize, ambient]);

  const at = (e: React.PointerEvent): Point => ({ x: e.clientX, y: e.clientY });
  const moved = (a: Point, b: Point) => Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) >= clickSlop;
  // Where the drag has taken the selection by point p.
  const follow = (d: Drag, p: Point): Rect | null => {
    const v = viewport();
    if (d.kind === 'draw') return rectFrom(d.from, p, v);
    if (!d.base) return null;
    const dx = p.x - d.from.x;
    const dy = p.y - d.from.y;
    return d.kind === 'move' ? moveRect(d.base, dx, dy, v) : resizeRect(d.base, d.kind, dx, dy, v, minSize);
  };
  const restore = (d: Drag) => {
    setRect(d.base);
    setPhase(d.base ? 'adjust' : 'idle');
  };

  const r = rect;
  const dim = ambient ? 'rgba(9,9,11,0.3)' : 'rgba(9,9,11,0.45)';
  // The toolbar: just below the selection, above it near the bottom edge, always on screen.
  const gap = 8;
  let barTop = 0;
  let barLeft = 0;
  if (r) {
    const v = viewport();
    const h = bar.height || 32;
    barTop = r.y + r.height + gap + h <= v.height - gap ? r.y + r.height + gap : r.y - gap - h >= gap ? r.y - gap - h : Math.max(gap, r.y + r.height - gap - h);
    barLeft = Math.max(gap, Math.min(r.x, v.width - (bar.width || 0) - gap));
  }
  const setSize = (key: 'width' | 'height', value: string) => {
    setDraft((d) => ({ ...d, [key]: value }));
    const n = Math.round(Number(value));
    if (!Number.isFinite(n) || n < minSize) return;
    // From the top-left, clamped to the viewport.
    setRect((cur) => (cur ? { ...cur, [key]: Math.min(n, (key === 'width' ? viewport().width - cur.x : viewport().height - cur.y)) } : cur));
  };
  const field = (key: 'width' | 'height', label: string) => (
    <input
      aria-label={label}
      inputMode="numeric"
      value={draft[key] ?? String(Math.round(r ? r[key] : 0))}
      onChange={(e) => setSize(key, e.target.value)}
      onBlur={() => setDraft((d) => ({ ...d, [key]: undefined }))}
      onFocus={(e) => e.currentTarget.select()}
      style={s.field}
    />
  );

  return createPortal(
    <>
      <div
        ref={ref}
        tabIndex={-1}
        {...(ambient ? { 'data-shipcue-capture': '' } : { role: 'dialog', 'aria-modal': 'true' as const, 'aria-label': 'Select an area', 'data-shipcue-select': '' })}
        style={ambient ? { ...s.layer, zIndex: 2147482999 } : s.layer}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          const el = e.target as Element;
          const handle = el.closest?.('[data-shipcue-handle]')?.getAttribute('data-shipcue-handle') as Handle | null | undefined;
          const inside = !!el.closest?.('[data-shipcue-selection]');
          const kind = adjusting && handle ? handle : adjusting && inside ? 'move' : 'draw';
          drag.current = { kind, from: at(e), base: adjusting ? rectRef.current : null, live: kind !== 'draw' };
          try {
            e.currentTarget.setPointerCapture?.(e.pointerId);
          } catch {
            // An unknown pointer (some synthetic events).
          }
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const p = at(e);
          if (!d.live) {
            // Ambient, or over a drawn selection: a small wobble is still a click.
            if ((ambient || d.base) && !moved(d.from, p)) return;
            d.live = true;
            setPhase('draw');
          }
          setRect(follow(d, p));
          setDraft({});
        }}
        onPointerCancel={() => {
          const d = drag.current;
          drag.current = null;
          if (d) restore(d);
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          if (!d) return;
          if (!d.live) {
            // A click: on the bare tint (ambient) it lifts it; over a selection it keeps it.
            if (ambient && !d.base) onDismiss?.();
            return;
          }
          const next = follow(d, at(e));
          if (!next || isTiny(next, minSize)) {
            restore(d);
            return;
          }
          setRect(next);
          setPhase('adjust');
          setDraft({});
          // Ambient: the keys (Enter, Esc, arrows) come here now, not to the panel's text box.
          if (ambient) ref.current?.focus();
        }}
      >
        {r && r.width > 0 && r.height > 0 ? (
          <>
            {/* Four bands of tint around the selection, so the selection itself shows undimmed. */}
            <div style={{ ...s.band, background: dim, left: 0, top: 0, right: 0, height: r.y }} />
            <div style={{ ...s.band, background: dim, left: 0, top: r.y + r.height, right: 0, bottom: 0 }} />
            <div style={{ ...s.band, background: dim, left: 0, top: r.y, width: r.x, height: r.height }} />
            <div style={{ ...s.band, background: dim, left: r.x + r.width, top: r.y, right: 0, height: r.height }} />
            <div data-shipcue-selection="" style={{ ...s.sel, left: r.x, top: r.y, width: r.width, height: r.height, ...(adjusting ? { pointerEvents: 'auto', cursor: 'move' } : null) }}>
              {adjusting &&
                HANDLES.map((h) => (
                  <div key={h} data-shipcue-handle={h} aria-hidden="true" style={{ ...s.handle, width: hit, height: hit, left: AT[h][0], top: AT[h][1], cursor: CURSOR[h] }}>
                    <span style={s.knob} />
                  </div>
                ))}
            </div>
            {!adjusting && (
              <span style={{ ...s.size, left: r.x, top: r.y + r.height + 6 > window.innerHeight - 24 ? Math.max(0, r.y - 24) : r.y + r.height + 6 }}>
                {Math.round(r.width)} × {Math.round(r.height)}
              </span>
            )}
          </>
        ) : (
          <div style={{ ...s.band, background: dim, inset: 0 }} />
        )}
        <p {...(ambient && !adjusting ? null : { role: 'status' })} style={ambient ? s.ambientHint : s.hint}>
          {adjusting ? t.adjustHint : hint}
        </p>
      </div>
      {adjusting && r && (
        <div ref={barRef} role="toolbar" aria-label={t.selectionToolbar} data-shipcue-selection-bar="" style={{ ...s.bar, top: barTop, left: barLeft }}>
          {field('width', t.selectionWidth)}
          <span aria-hidden="true" style={s.times}>×</span>
          {field('height', t.selectionHeight)}
          <span aria-hidden="true" style={s.sep} />
          <button type="button" onClick={cancel} style={s.btn}>
            {t.cancel}
          </button>
          <button type="button" onClick={() => capture(false)} title={`${t.captureNow} (Enter)`} style={s.btn}>
            {t.captureNow}
          </button>
          <button type="button" onClick={() => capture(true)} style={{ ...s.btn, ...s.primary }}>
            {t.captureAnnotate}
          </button>
        </div>
      )}
    </>,
    document.body,
  );
}

const font = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
const s: Record<string, CSSProperties> = {
  layer: { position: 'fixed', inset: 0, zIndex: 2147483600, cursor: 'crosshair', touchAction: 'none', userSelect: 'none', outline: 'none' },
  band: { position: 'absolute', pointerEvents: 'none' },
  sel: { position: 'absolute', boxSizing: 'border-box', border: '1px solid rgba(255,255,255,0.9)', boxShadow: '0 0 0 1px rgba(9,9,11,0.35)', pointerEvents: 'none' },
  handle: { position: 'absolute', transform: 'translate(-50%, -50%)', display: 'flex', alignItems: 'center', justifyContent: 'center', touchAction: 'none' },
  knob: { width: 8, height: 8, boxSizing: 'border-box', borderRadius: 2, background: '#fff', border: '1px solid rgba(9,9,11,0.5)', pointerEvents: 'none' },
  size: { position: 'absolute', padding: '2px 6px', borderRadius: 4, background: 'rgba(9,9,11,0.75)', color: '#fff', fontSize: 11, fontFamily: font, pointerEvents: 'none', whiteSpace: 'nowrap' },
  ambientHint: { position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)', margin: 0, padding: '3px 9px', borderRadius: 999, background: 'rgba(9,9,11,0.6)', color: 'rgba(255,255,255,0.9)', fontSize: 11, fontFamily: font, pointerEvents: 'none', whiteSpace: 'nowrap', maxWidth: 'calc(100vw - 32px)', overflow: 'hidden', textOverflow: 'ellipsis' },
  hint: { position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', margin: 0, padding: '4px 10px', borderRadius: 999, background: 'rgba(9,9,11,0.75)', color: '#fff', fontSize: 12, fontFamily: font, pointerEvents: 'none', whiteSpace: 'nowrap', maxWidth: 'calc(100vw - 32px)', overflow: 'hidden', textOverflow: 'ellipsis' },
  // Over the tint and the report panel, so a selection under the panel can still be captured.
  bar: { position: 'fixed', zIndex: 2147483601, display: 'flex', alignItems: 'center', gap: 4, padding: 4, borderRadius: 8, background: 'rgba(24,24,27,0.94)', boxShadow: '0 4px 16px rgba(0,0,0,0.25)', fontFamily: font, fontSize: 11, color: '#fff', whiteSpace: 'nowrap', maxWidth: 'calc(100vw - 16px)' },
  field: { width: 40, boxSizing: 'border-box', padding: '3px 4px', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 4, background: 'rgba(255,255,255,0.08)', color: '#fff', font: 'inherit', fontVariantNumeric: 'tabular-nums', textAlign: 'center', outline: 'none' },
  times: { color: 'rgba(255,255,255,0.5)' },
  sep: { width: 1, height: 16, margin: '0 2px', background: 'rgba(255,255,255,0.15)' },
  btn: { padding: '3px 9px', border: 0, borderRadius: 999, background: 'transparent', color: 'rgba(255,255,255,0.85)', font: 'inherit', cursor: 'pointer' },
  primary: { background: '#fff', color: '#18181b', fontWeight: 500 },
};
