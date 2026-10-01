'use client';

import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import { PRIORITIES, PRIORITY_HINT, PRIORITY_LABEL, resolveConfig, type Area, type Priority, type ReportType } from '../core';
import { shrinkImage } from './shrink';

export type SubmitResult = { id: string } | { error: string };

export interface ReportButtonProps {
  /** The parts of your app a report can be about. "Other" is always added. */
  areas?: Area[];
  /** Where createFixqueueHandler is mounted. Ignored when `submit` is given. */
  endpoint?: string;
  /** Send the form yourself, e.g. through a Next.js server action. */
  submit?: (form: FormData) => Promise<SubmitResult>;
  /** A snapshot of app state attached to every report, for whoever fixes it. Keep it under 64 KB. */
  diagnostics?: () => Record<string, unknown>;
  /** `floating`: bottom-right bubble. `inline`: a small button for a header or toolbar. */
  variant?: 'floating' | 'inline';
  /** Button and focus colour. */
  accentColor?: string;
  /** Shown after a report is sent, e.g. a link to your queue. */
  successMessage?: React.ReactNode;
  onSubmitted?: (id: string) => void;
}

const TYPES: { value: ReportType; label: string; placeholder: string }[] = [
  { value: 'bug', label: 'Bug', placeholder: 'I pressed Enter at the end of a heading and the heading disappeared.' },
  { value: 'feature', label: 'Feature request', placeholder: 'It would help to nest pages under other pages.' },
];

const ACCEPT = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

async function postTo(endpoint: string, form: FormData): Promise<SubmitResult> {
  const res = await fetch(`${endpoint.replace(/\/$/, '')}/reports`, { method: 'POST', body: form });
  const body = (await res.json().catch(() => ({}))) as Partial<{ id: string; error: string }>;
  if (res.ok && body.id) return { id: body.id };
  return { error: body.error ?? 'Could not send the report. Please try again.' };
}

function snapshot(diagnostics?: () => Record<string, unknown>): string {
  if (!diagnostics) return '{}';
  try {
    return JSON.stringify(diagnostics());
  } catch (err) {
    return JSON.stringify({ diagnosticsError: err instanceof Error ? err.message : String(err) });
  }
}

export function ReportButton({
  areas,
  endpoint = '/api/fixqueue',
  submit,
  diagnostics,
  variant = 'floating',
  accentColor = '#18181b',
  successMessage = 'Thanks. It is in the queue.',
  onSubmitted,
}: ReportButtonProps) {
  const config = useMemo(() => resolveConfig({ areas }), [areas]);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [type, setType] = useState<ReportType>('bug');
  const [priority, setPriority] = useState<Priority>('medium');
  const [area, setArea] = useState('other');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const uid = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const previews = useMemo(() => files.map((f) => URL.createObjectURL(f)), [files]);
  useEffect(() => () => previews.forEach((u) => URL.revokeObjectURL(u)), [previews]);

  useEffect(() => {
    if (open) textareaRef.current?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    setDone(false);
    setError(null);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const addFiles = async (incoming: File[]) => {
    setError(null);
    const next = [...files];
    for (const raw of incoming) {
      // Retina screenshots are re-encoded smaller in the browser first.
      const f = await shrinkImage(raw);
      if (!ACCEPT.includes(f.type)) {
        setError('Screenshots must be PNG, JPG, WebP or GIF.');
        continue;
      }
      if (f.size > config.maxScreenshotBytes) {
        setError(`Each screenshot must be under ${Math.round(config.maxScreenshotBytes / 1024 / 1024)} MB.`);
        continue;
      }
      if (next.length >= config.maxScreenshots) {
        setError(`Up to ${config.maxScreenshots} screenshots.`);
        break;
      }
      next.push(f);
    }
    setFiles(next);
  };

  const send = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set('type', type);
      form.set('description', text);
      form.set('priority', priority);
      form.set('area', area);
      form.set('pageUrl', window.location.href);
      form.set('userAgent', navigator.userAgent);
      form.set('diagnostics', snapshot(diagnostics));
      files.forEach((f) => form.append('screenshot', f, f.name));
      const result = submit ? await submit(form) : await postTo(endpoint, form);
      if ('error' in result) throw new Error(result.error);
      setDone(true);
      setText('');
      setFiles([]);
      onSubmitted?.(result.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the report. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const canSend = !busy && text.trim().length >= config.minLength;
  const current = TYPES.find((t) => t.value === type)!;
  const s = styles(accentColor);

  return (
    <div data-fixqueue={variant} style={variant === 'floating' ? s.floatingWrap : s.inlineWrap}>
      {open && (
        <div role="dialog" aria-label="Report a bug" style={variant === 'floating' ? s.panel : s.inlinePanel}>
          <div style={s.row}>
            <div>
              <h3 style={s.h3}>{type === 'bug' ? 'Report a bug' : 'Request a feature'}</h3>
              <p style={s.sub}>
                {type === 'bug' ? 'Say what you did and what happened.' : 'Say what you want and why it helps.'}
              </p>
            </div>
            <button type="button" onClick={close} aria-label="Close" style={s.iconBtn}>
              ×
            </button>
          </div>

          {done ? (
            <div role="status" style={s.success}>
              {successMessage}
            </div>
          ) : (
            <>
              <div role="radiogroup" aria-label="Report type" style={s.segment}>
                {TYPES.map((t) => (
                  <button
                    key={t.value}
                    type="button"
                    role="radio"
                    aria-checked={type === t.value}
                    onClick={() => setType(t.value)}
                    style={type === t.value ? s.segOn : s.segOff}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              <textarea
                ref={textareaRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onPaste={(e) => {
                  const imgs = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'));
                  if (imgs.length) {
                    e.preventDefault();
                    void addFiles(imgs);
                  }
                }}
                rows={4}
                placeholder={current.placeholder}
                style={s.textarea}
              />
              <div style={s.grid}>
                <div>
                  <label htmlFor={`${uid}-priority`} style={s.label}>
                    Priority
                  </label>
                  <select id={`${uid}-priority`} value={priority} onChange={(e) => setPriority(e.target.value as Priority)} style={s.select}>
                    {PRIORITIES.map((p) => (
                      <option key={p} value={p}>
                        {PRIORITY_LABEL[p]}
                      </option>
                    ))}
                  </select>
                  <p style={s.hint}>{PRIORITY_HINT[priority]}</p>
                </div>
                <div>
                  <label htmlFor={`${uid}-area`} style={s.label}>
                    Where
                  </label>
                  <select id={`${uid}-area`} value={area} onChange={(e) => setArea(e.target.value)} style={s.select}>
                    {config.areas.map((a) => (
                      <option key={a.value} value={a.value}>
                        {a.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <input
                ref={fileInputRef}
                type="file"
                accept={ACCEPT.join(',')}
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files) void addFiles(Array.from(e.target.files));
                  e.target.value = '';
                }}
              />
              <div style={s.thumbs}>
                {previews.map((src, i) => (
                  <div key={src + i} style={{ position: 'relative' }}>
                    <img src={src} alt={`Screenshot ${i + 1}`} style={s.thumb} />
                    <button
                      type="button"
                      aria-label={`Remove screenshot ${i + 1}`}
                      onClick={() => setFiles(files.filter((_, j) => j !== i))}
                      style={s.remove}
                    >
                      ×
                    </button>
                  </div>
                ))}
                {files.length < config.maxScreenshots && (
                  <button type="button" onClick={() => fileInputRef.current?.click()} style={s.addShot}>
                    + screenshot
                  </button>
                )}
              </div>
              <p style={s.hint}>Paste a screenshot into the text box, or add up to {config.maxScreenshots}.</p>

              {error && (
                <p role="alert" style={s.error}>
                  {error}
                </p>
              )}
              <div style={{ ...s.row, alignItems: 'center', marginTop: 12 }}>
                <p style={s.hint}>The page address is attached automatically.</p>
                <button type="button" onClick={send} disabled={!canSend} style={canSend ? s.send : { ...s.send, opacity: 0.5, cursor: 'not-allowed' }}>
                  {busy ? 'Sending…' : 'Send'}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-label={open ? 'Close report' : 'Report a bug or request a feature'}
        title="Report a bug or request a feature"
        style={variant === 'floating' ? s.fab : s.inlineBtn}
      >
        <svg width={variant === 'floating' ? 22 : 18} height={variant === 'floating' ? 22 : 18} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M8 8V7a4 4 0 0 1 8 0v1M6 12H3M21 12h-3M6 16l-2.5 1.5M18 16l2.5 1.5M6.5 8.5 4 7M17.5 8.5 20 7"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
          <rect x="7" y="8" width="10" height="12" rx="5" stroke="currentColor" strokeWidth="1.6" />
          <path d="M12 10v8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

// Inline styles so the button works in any app with no CSS setup.
function styles(accent: string) {
  const font = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
  const card: CSSProperties = {
    boxSizing: 'border-box',
    background: '#fff',
    color: '#18181b',
    border: '1px solid #e4e4e7',
    borderRadius: 16,
    padding: 16,
    boxShadow: '0 12px 32px rgba(24,24,27,0.12)',
    fontFamily: font,
    overflowY: 'auto',
  };
  const field: CSSProperties = {
    boxSizing: 'border-box',
    width: '100%',
    border: '1px solid #d4d4d8',
    borderRadius: 8,
    fontSize: 14,
    fontFamily: font,
    color: '#27272a',
    background: '#fff',
  };
  const seg: CSSProperties = { flex: 1, border: 0, borderRadius: 6, padding: '4px 8px', fontSize: 12, fontWeight: 500, cursor: 'pointer' };
  return {
    floatingWrap: {
      position: 'fixed',
      right: 16,
      bottom: 'calc(16px + env(safe-area-inset-bottom))',
      zIndex: 2147483000,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-end',
      gap: 8,
    } as CSSProperties,
    inlineWrap: { display: 'inline-block' } as CSSProperties,
    panel: { ...card, width: 'min(92vw, 24rem)', maxHeight: 'calc(100dvh - 6rem)' } as CSSProperties,
    inlinePanel: {
      ...card,
      position: 'fixed',
      left: 12,
      right: 12,
      bottom: 'calc(12px + env(safe-area-inset-bottom))',
      zIndex: 2147483000,
      maxHeight: '85vh',
    } as CSSProperties,
    row: { display: 'flex', justifyContent: 'space-between', gap: 8 } as CSSProperties,
    h3: { margin: 0, fontSize: 14, fontWeight: 600 } as CSSProperties,
    sub: { margin: '2px 0 0', fontSize: 12, color: '#71717a' } as CSSProperties,
    iconBtn: { border: 0, background: 'transparent', color: '#a1a1aa', fontSize: 18, lineHeight: 1, cursor: 'pointer', padding: 4 } as CSSProperties,
    success: { marginTop: 12, borderRadius: 8, background: '#ecfdf5', color: '#065f46', padding: '8px 12px', fontSize: 12 } as CSSProperties,
    segment: { display: 'flex', gap: 4, marginTop: 12, background: '#f4f4f5', borderRadius: 8, padding: 2 } as CSSProperties,
    segOn: { ...seg, background: '#fff', color: '#18181b', boxShadow: '0 1px 2px rgba(0,0,0,0.08)' } as CSSProperties,
    segOff: { ...seg, background: 'transparent', color: '#71717a' } as CSSProperties,
    textarea: { ...field, marginTop: 12, padding: '8px 12px', resize: 'none' } as CSSProperties,
    grid: { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 8, marginTop: 8 } as CSSProperties,
    label: { display: 'block', fontSize: 11, fontWeight: 500, color: '#71717a' } as CSSProperties,
    select: { ...field, marginTop: 4, padding: '6px 8px' } as CSSProperties,
    hint: { margin: '2px 0 0', fontSize: 10, color: '#a1a1aa', fontWeight: 400 } as CSSProperties,
    thumbs: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 } as CSSProperties,
    thumb: { width: 56, height: 56, objectFit: 'cover', borderRadius: 6, border: '1px solid #e4e4e7' } as CSSProperties,
    remove: {
      position: 'absolute',
      top: -6,
      right: -6,
      width: 20,
      height: 20,
      borderRadius: 999,
      border: 0,
      background: '#27272a',
      color: '#fff',
      fontSize: 11,
      cursor: 'pointer',
    } as CSSProperties,
    addShot: {
      width: 56,
      height: 56,
      border: '1px dashed #d4d4d8',
      borderRadius: 6,
      background: 'transparent',
      color: '#71717a',
      fontSize: 10,
      cursor: 'pointer',
    } as CSSProperties,
    error: { marginTop: 8, borderRadius: 8, background: '#fff1f2', color: '#be123c', padding: '8px 12px', fontSize: 12 } as CSSProperties,
    send: { border: 0, borderRadius: 8, background: accent, color: '#fff', padding: '6px 12px', fontSize: 14, fontWeight: 500, cursor: 'pointer' } as CSSProperties,
    fab: {
      width: 48,
      height: 48,
      borderRadius: 999,
      border: 0,
      background: accent,
      color: '#fff',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      boxShadow: '0 8px 20px rgba(0,0,0,0.2)',
      cursor: 'pointer',
    } as CSSProperties,
    inlineBtn: {
      width: 36,
      height: 36,
      borderRadius: 999,
      border: 0,
      background: accent,
      color: '#fff',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      cursor: 'pointer',
    } as CSSProperties,
  };
}
