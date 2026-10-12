'use client';

import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { Rect } from './capture';

/** CSS px the clear hole reaches past the selection, so the crop's rounding never picks up tint. */
export const VEIL_GAP = 2;
/** Room (CSS px) the spinner needs beside the hole; with less on both sides it waits for the full tint. */
const PILL_ROOM = 40;
const TINT = 'rgba(9,9,11,0.35)';

/**
 * The page while a screenshot is taken (Habitect report cbb24947): no blank wait. Until the
 * picture is taken (`hole` set) the page is tinted around the selection, which stays clear so
 * none of the tint is in it; after that (`hole` null) all of it is, until the screenshot is in
 * the panel. A spinner says what is happening, and the page takes no clicks meanwhile.
 */
export function CaptureVeil({ hole, label }: { hole: Rect | null; label: string }) {
  if (typeof document === 'undefined') return null;
  const clear = hole && { x: hole.x - VEIL_GAP, y: hole.y - VEIL_GAP, width: hole.width + 2 * VEIL_GAP, height: hole.height + 2 * VEIL_GAP };
  const pill = clear ? pillBeside(clear) : s.centred;
  return createPortal(
    <div data-shipcue-capture-veil="" style={clear ? s.veil : { ...s.veil, background: TINT }}>
      <style>{SPIN}</style>
      {clear && <div data-shipcue-capture-hole="" style={{ ...s.hole, left: clear.x, top: clear.y, width: clear.width, height: clear.height }} />}
      {pill && (
        <p role="status" style={{ ...s.pill, ...pill }}>
          <span aria-hidden="true" data-shipcue-spinner="" style={s.spinner} />
          {label}
        </p>
      )}
    </div>,
    document.body,
  );
}

/** Under the hole, else over it; null when the hole leaves no room for it. */
function pillBeside(hole: Rect): CSSProperties | null {
  const centre = { left: hole.x + hole.width / 2, transform: 'translateX(-50%)' };
  if (window.innerHeight - (hole.y + hole.height) >= PILL_ROOM) return { ...centre, top: hole.y + hole.height + 8 };
  if (hole.y >= PILL_ROOM) return { ...centre, top: hole.y - PILL_ROOM + 8 };
  return null;
}

const SPIN =
  '@keyframes shipcue-spin{to{transform:rotate(360deg)}}[data-shipcue-spinner]{animation:shipcue-spin .8s linear infinite}@media (prefers-reduced-motion:reduce){[data-shipcue-spinner]{animation-duration:2.4s}}';
const font = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
const s: Record<string, CSSProperties> = {
  // Under the report panel (as the dim is), which stays usable.
  veil: { position: 'fixed', inset: 0, zIndex: 2147482999, cursor: 'progress' },
  hole: { position: 'absolute', boxShadow: `0 0 0 200vmax ${TINT}`, pointerEvents: 'none' },
  centred: { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' },
  pill: { position: 'absolute', display: 'flex', alignItems: 'center', gap: 8, margin: 0, padding: '5px 12px', borderRadius: 999, background: 'rgba(9,9,11,0.75)', color: '#fff', fontSize: 12, fontFamily: font, whiteSpace: 'nowrap', pointerEvents: 'none' },
  spinner: { width: 12, height: 12, boxSizing: 'border-box', borderRadius: '50%', border: '2px solid rgba(255,255,255,0.3)', borderTopColor: '#fff' },
};
