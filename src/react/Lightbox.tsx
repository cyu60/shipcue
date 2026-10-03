import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { shotAlt } from '../core';

// Click a screenshot, see it big on the page, close it: no new tab (outliner report eea8e2be).
// Fits the screen; click the image to see it at full size and scroll around; Esc, × or the
// backdrop closes; ← and → move between the images it was opened with.

export interface LightboxProps {
  images: string[];
  /** Which one to show first. */
  index: number;
  onClose: () => void;
  /** Labels, so apps can use their own words. */
  label?: string;
  /** Alt text per image; without it, each image's own (#alt= or ;alt=, shipcue report 58b727d9). */
  alts?: (string | null | undefined)[];
}

export function Lightbox({ images, index: start, onClose, label = 'Screenshot', alts }: LightboxProps) {
  const [index, setIndex] = useState(start);
  const [zoomed, setZoomed] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const count = images.length;
  const go = (step: number) => {
    setZoomed(false);
    setIndex((i) => (i + step + count) % count);
  };
  const goRef = useRef(go);
  goRef.current = go;

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
      } else if (e.key === 'ArrowRight' && count > 1) {
        e.preventDefault();
        goRef.current(1);
      } else if (e.key === 'ArrowLeft' && count > 1) {
        e.preventDefault();
        goRef.current(-1);
      }
    };
    // Capture: the panel's own Esc (close the report form) must not fire too.
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      before?.focus?.();
    };
  }, [count]);

  const src = images[index] ?? '';
  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label={`${label} ${index + 1} of ${count}`} tabIndex={-1} style={s.backdrop} onClick={() => onClose()}>
      <div style={zoomed ? s.scrollZoomed : s.scroll} onClick={(e) => e.target === e.currentTarget && onClose()}>
        <img
          src={src}
          alt={alts?.[index] || shotAlt(src) || `${label} ${index + 1}`}
          onClick={(e) => {
            e.stopPropagation();
            setZoomed((z) => !z);
          }}
          style={zoomed ? s.imgZoomed : s.img}
        />
      </div>
      <button type="button" aria-label="Close" onClick={(e) => (e.stopPropagation(), onClose())} style={{ ...s.btn, top: 12, right: 12 }}>
        ×
      </button>
      {count > 1 && (
        <>
          <button type="button" aria-label="Previous" onClick={(e) => (e.stopPropagation(), go(-1))} style={{ ...s.btn, left: 12, top: '50%' }}>
            ‹
          </button>
          <button type="button" aria-label="Next" onClick={(e) => (e.stopPropagation(), go(1))} style={{ ...s.btn, right: 12, top: '50%' }}>
            ›
          </button>
          <span style={s.count}>
            {index + 1} / {count}
          </span>
        </>
      )}
    </div>
  );
}

/** State for a lightbox: open(images, i) shows it, and `box` renders it (or nothing). */
export function useLightbox(label?: string) {
  const [shown, setShown] = useState<{ images: string[]; index: number; alts?: (string | null | undefined)[] } | null>(null);
  return {
    open: (images: string[], index: number, alts?: (string | null | undefined)[]) => setShown({ images, index, alts }),
    // On document.body, so no panel or drawer it was opened from can clip it or sit on top of it.
    box:
      shown && typeof document !== 'undefined'
        ? createPortal(<Lightbox images={shown.images} index={shown.index} label={label} alts={shown.alts} onClose={() => setShown(null)} />, document.body)
        : null,
  };
}

const s: Record<string, CSSProperties> = {
  backdrop: { position: 'fixed', inset: 0, zIndex: 2147483600, background: 'rgba(9,9,11,0.82)', display: 'flex', alignItems: 'center', justifyContent: 'center', outline: 'none' },
  scroll: { width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40, boxSizing: 'border-box' },
  scrollZoomed: { width: '100%', height: '100%', overflow: 'auto', padding: 40, boxSizing: 'border-box' },
  img: { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: 6, cursor: 'zoom-in', boxShadow: '0 12px 40px rgba(0,0,0,0.45)', background: '#fff' },
  imgZoomed: { display: 'block', margin: '0 auto', maxWidth: 'none', cursor: 'zoom-out', background: '#fff' },
  btn: {
    position: 'absolute',
    width: 36,
    height: 36,
    marginTop: 0,
    border: 0,
    borderRadius: 999,
    background: 'rgba(255,255,255,0.92)',
    color: '#18181b',
    fontSize: 22,
    lineHeight: '36px',
    textAlign: 'center',
    cursor: 'pointer',
    padding: 0,
    transform: 'translateY(0)',
  },
  count: { position: 'absolute', bottom: 14, left: '50%', transform: 'translateX(-50%)', color: '#fff', fontSize: 12, fontFamily: 'ui-sans-serif, system-ui, sans-serif', opacity: 0.85 },
};
