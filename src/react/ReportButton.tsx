'use client';

import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import { chordOf, CLOSE_EVENT, defaultHotkeys, display, hotkeyType, isMac, loadUserHotkeys, OPEN_EVENT, saveUserHotkeys, type Hotkeys } from './hotkeys';
import { BLOCKED_FILE_TYPES, formatBytes, PRIORITIES, PRIORITY_HINT, PRIORITY_LABEL, resolveConfig, videoType, type Area, type Capabilities, type Limits, type Priority, type ReportType } from '../core';
import { captureErrors as startCapturingErrors, recentErrors } from './errors';
import { shrinkImage } from './shrink';
import { canRecordScreen, recordScreen, shareError, type ScreenRecording } from './video';

export type SubmitResult = { id: string } | { error: string };

export interface ReportButtonProps {
  /** The parts of your app a report can be about. "Other" is always added. */
  areas?: Area[];
  /** Where createShipcueHandler is mounted. Ignored when `submit` is given. */
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
  /**
   * Upload a video for a filed report yourself, e.g. straight from the browser
   * to your storage with a presigned URL. Without it, the button posts the
   * video to the handler ({endpoint}/reports/:id/video, needs saveVideo), and
   * when `submit` is given and this is not, video is hidden.
   */
  uploadVideo?: (reportId: string, video: Blob) => Promise<void>;
  /** Attach recent page errors to every report. On by default. */
  captureErrors?: boolean;
  /**
   * How many screenshots, how big, and how long a video may be. With the built-in endpoint the
   * button reads these from the handler (its resolveConfig), so set them there once; pass them
   * here when you send reports yourself with `submit`. Given here, they win.
   */
  limits?: Partial<Limits>;
  /**
   * Open your app's own shortcut editor from the panel's Shortcuts link, for apps whose keymap
   * opens shipcue (hotkeys={false}). Without it, the link edits shipcue's own hotkeys in place.
   */
  onEditShortcuts?: () => void;
  /** Where people can see the reports they sent; shown as a Past reports link. */
  pastReportsHref?: string;
  /** The text of that link. "Past reports" by default. */
  pastReportsLabel?: string;
  /** The link on the thanks note after sending, to the same place. "See your CueLog" by default. */
  seeReportsLabel?: string;
  /** A small "Powered by shipcue" line asking people to star it on GitHub. On by default. */
  watermark?: boolean;
  /** Which tabs to show, in order. All three by default; on a public page you may want to leave out 'task'. */
  types?: ReportType[];
  /**
   * Shortcuts that open the panel on a tab. On a Mac ⌘J agent task, ⌃B bug, ⌃F feature;
   * elsewhere Alt+Shift+J/B/F. Pass your own chords per tab ("Mod+J", "Ctrl+B"), or false for none.
   */
  hotkeys?: Hotkeys | false;
  /**
   * What the report is about when nothing is highlighted on the page, e.g. the selected rows or
   * blocks in your app as text. Shown in an editable Context box the reporter can remove.
   */
  getContext?: () => string | null | undefined;
  /** Called when the panel opens or closes. */
  onOpenChange?: (open: boolean) => void;
  /**
   * Tabs of your own, drawn inside the same panel after the report tabs: e.g. an agent-task
   * composer backed by your API. `render` gets the draft so far and a `close` function.
   * Give one a hotkey with hotkeys={{ [id]: ['Mod+J'] }}, or open it with openReport(id).
   */
  extraTabs?: ExtraTab[];
  /**
   * false draws no button of its own: open the panel from your existing menu or help button with
   * openReport(), or with the hotkeys.
   */
  trigger?: boolean;
  /**
   * Hide shipcue (button and hotkeys) unless the page is opened with ?<showParam>=true, e.g.
   * showParam="shipcue" for ?shipcue=true. Remembered for the tab; ?shipcue=false hides it again.
   * Unset (the default): always shown.
   */
  showParam?: string;
}

/** Whether ?<param>=true turned shipcue on for this tab (remembered in sessionStorage). */
export function shownByParam(param: string): boolean {
  if (typeof window === 'undefined') return false;
  const key = `shipcue:show:${param}`;
  const value = new URLSearchParams(window.location.search).get(param);
  try {
    if (value === 'true' || value === '1') sessionStorage.setItem(key, '1');
    if (value === 'false' || value === '0') sessionStorage.removeItem(key);
    return sessionStorage.getItem(key) === '1';
  } catch {
    return value === 'true' || value === '1';
  }
}

export function ReportButton(props: ReportButtonProps) {
  const { showParam } = props;
  // Decided after mount: the server render and the first client render agree (hidden).
  const [shown, setShown] = useState(!showParam);
  useEffect(() => {
    if (showParam) setShown(shownByParam(showParam));
  }, [showParam]);
  return shown ? <ReportPanel {...props} /> : null;
}

export interface ExtraTab {
  id: string;
  label: string;
  /** Panel heading on this tab; the label by default. */
  title?: string;
  subtitle?: string;
  render: (draft: { text: string; context: string | null; close: () => void }) => React.ReactNode;
}

const TYPES: { value: ReportType; label: string; placeholder: string }[] = [
  { value: 'bug', label: 'Bug', placeholder: 'I pressed Enter at the end of a heading and the heading disappeared.' },
  { value: 'feature', label: 'Feature request', placeholder: 'It would help to nest pages under other pages.' },
  { value: 'task', label: 'Agent task', placeholder: 'Add a CSV export to the reports page, with the same columns as the table.' },
];

const HEADING: Record<ReportType, [string, string]> = {
  bug: ['Report a bug', 'Say what you did and what happened.'],
  feature: ['Request a feature', 'Say what you want and why it helps.'],
  task: ['New agent task', 'Delegate a task to your agent.'],
};

const ACCEPT = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

async function postTo(endpoint: string, form: FormData): Promise<SubmitResult> {
  const res = await fetch(`${endpoint.replace(/\/$/, '')}/reports`, { method: 'POST', body: form });
  const body = (await res.json().catch(() => ({}))) as Partial<{ id: string; error: string }>;
  if (res.ok && body.id) return { id: body.id };
  return { error: body.error ?? 'Could not send the report. Please try again.' };
}

function snapshot(diagnostics: (() => Record<string, unknown>) | undefined, withErrors: boolean): string {
  let app: Record<string, unknown> = {};
  try {
    app = diagnostics ? diagnostics() : {};
  } catch (err) {
    app = { diagnosticsError: err instanceof Error ? err.message : String(err) };
  }
  const errors = withErrors ? recentErrors() : [];
  return JSON.stringify(errors.length ? { ...app, recentErrors: errors } : app);
}

/** A failed video upload as a sentence: storage and hosts word size refusals in their own ways. */
export function videoError(e: unknown, size: number, max: number): string {
  const msg = e instanceof Error ? e.message : '';
  if (/too big|too large|exceeds|size limit|maximum.*size|payload|413/i.test(msg)) {
    return `the video (${formatBytes(size)}) is too big to upload here (up to ${formatBytes(max)}). The report itself was sent.`;
  }
  return msg || 'Could not upload the video. The report itself was sent.';
}

async function postVideo(endpoint: string, reportId: string, video: Blob): Promise<void> {
  const form = new FormData();
  form.set('video', video, `video.${videoType(video.type) === 'video/mp4' ? 'mp4' : videoType(video.type) === 'video/quicktime' ? 'mov' : 'webm'}`);
  const res = await fetch(`${endpoint.replace(/\/$/, '')}/reports/${reportId}/video`, { method: 'POST', body: form });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    // A host's own limit (Vercel: 4.5 MB per request) answers before the handler does.
    if (res.status === 413) throw new Error(`The video (${formatBytes(video.size)}) is too big for this app to take. Try a shorter one.`);
    throw new Error(body.error ?? (res.status === 404 ? 'This app does not take videos.' : 'Could not upload the video.'));
  }
}

function ReportPanel({
  areas,
  endpoint = '/api/shipcue',
  submit,
  diagnostics,
  variant = 'floating',
  accentColor = '#18181b',
  successMessage = 'Thanks. It is in the queue.',
  onSubmitted,
  uploadVideo,
  captureErrors = true,
  pastReportsHref,
  pastReportsLabel = 'Past reports',
  seeReportsLabel = 'See your CueLog',
  limits,
  onEditShortcuts,
  watermark = true,
  types,
  hotkeys,
  getContext,
  onOpenChange,
  extraTabs,
  trigger = true,
}: ReportButtonProps) {
  const tabs = useMemo(() => (types?.length ? TYPES.filter((t) => types.includes(t.value)) : TYPES), [types]);
  const config = useMemo(() => resolveConfig({ areas }), [areas]);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [context, setContext] = useState<string | null>(null);
  const [extraId, setExtraId] = useState<string | null>(null);
  // After a send the panel closes and this short note says so (outliner report 22:47).
  const [sent, setSent] = useState<{ warning: string | null } | null>(null);
  useEffect(() => {
    if (!sent) return;
    const t = setTimeout(() => setSent(null), sent.warning ? 8000 : 4000);
    return () => clearTimeout(t);
  }, [sent]);
  const extra = extraTabs?.find((x) => x.id === extraId) ?? null;
  const [type, setType] = useState<ReportType>(() => tabs[0]?.value ?? 'bug');
  const [priority, setPriority] = useState<Priority>('medium');
  const [area, setArea] = useState('other');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState<string | null>(null);
  const [video, setVideo] = useState<{ blob: Blob; preview: string } | null>(null);
  const [recording, setRecording] = useState<number | null>(null);
  const recorderRef = useRef<ScreenRecording | null>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  // Video needs somewhere to go: your uploader, or the handler.
  // What the handler takes (GET {endpoint}/capabilities), so the panel only offers that
  // (shipcue report 04192848). 'legacy': an older handler without the route.
  const [caps, setCaps] = useState<Capabilities | 'loading' | 'legacy'>('loading');
  useEffect(() => {
    if (submit || !open || caps !== 'loading') return;
    let live = true;
    fetch(`${endpoint.replace(/\/$/, '')}/capabilities`, { cache: 'no-store' })
      .then(async (res) => (res.ok ? ((await res.json()) as Capabilities) : 'legacy'))
      .catch(() => 'legacy' as const)
      .then((c) => live && setCaps(c));
    return () => {
      live = false;
    };
  }, [open, submit, endpoint, caps]);
  const known = typeof caps === 'object' ? caps : null;
  const videoOn = !!uploadVideo || (!submit && (caps === 'legacy' || known?.video === 'form'));
  const filesOn = !!known?.files;
  // The real limit is the handler's when it said one (shipcue: fail gracefully on big videos).
  // Limits are never hard-coded: the handler's (from /capabilities), then the app's limits prop.
  const lim = useMemo<Limits>(() => {
    const fromServer: Partial<Limits> = known
      ? {
          maxScreenshots: known.maxScreenshots,
          maxScreenshotBytes: known.maxScreenshotBytes,
          maxTotalScreenshotBytes: known.maxTotalScreenshotBytes,
          maxVideoSeconds: known.maxVideoSeconds,
          // A video uploaded by the app itself is not held to the one-request cap.
          ...(uploadVideo ? {} : { maxVideoBytes: known.maxVideoBytes }),
        }
      : {};
    const defined = (o: Partial<Limits> | undefined) => Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => typeof v === 'number' && v > 0));
    return { ...config, ...defined(fromServer), ...defined(limits) } as Limits;
  }, [config, known, uploadVideo, limits]);
  const maxVideoBytes = lim.maxVideoBytes;
  const uid = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // While open, the panel never shrinks back (switching tabs, clearing text), so it does not jump.
  const contentRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const previews = useMemo(() => files.map((f) => (ACCEPT.includes(f.type) ? URL.createObjectURL(f) : '')), [files]);
  useEffect(() => () => previews.forEach((u) => u && URL.revokeObjectURL(u)), [previews]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!open || !el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [open, type]);

  useEffect(() => {
    if (captureErrors) startCapturingErrors();
  }, [captureErrors]);
  useEffect(() => (video?.preview ? () => URL.revokeObjectURL(video.preview) : undefined), [video]);

  const show = () => {
    setPage(window.location.href);
    setSent(null);
    setOpen(true);
  };

  // Shortcuts the person changed in the panel (shipcue report 0a73febd), kept in this browser.
  const [userKeys, setUserKeys] = useState<Hotkeys>({});
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is only there in the browser
    setUserKeys(loadUserHotkeys());
  }, []);
  const [editingKeys, setEditingKeys] = useState(false);
  const [keyFor, setKeyFor] = useState<string | null>(null);
  const recordingRef = useRef<string | null>(null);
  recordingRef.current = keyFor;
  const setUserKey = (id: string, chord: string | null) => {
    const next = { ...userKeys };
    if (chord) next[id] = [chord];
    else delete next[id];
    setUserKeys(next);
    saveUserHotkeys(next);
  };

  // The keys in use, only for the tabs on show: the app's, then the person's own.
  const appKeys = useMemo<Hotkeys>(() => (hotkeys === false ? {} : { ...defaultHotkeys(), ...hotkeys }), [hotkeys]);
  const keys = useMemo<Hotkeys>(() => {
    if (hotkeys === false) return {};
    const all = { ...appKeys, ...userKeys };
    const ids = [...tabs.map((t) => t.value as string), ...(extraTabs ?? []).map((x) => x.id)];
    return Object.fromEntries(ids.map((id) => [id, (all as Hotkeys)[id] ?? []]));
  }, [hotkeys, appKeys, userKeys, tabs, extraTabs]);

  // Open on a tab with what the report is about: the text highlighted on the page (not in
  // the panel), or else what the app says is selected.
  const pickContext = () => {
    const sel = window.getSelection();
    const picked = sel && !sel.isCollapsed && !panelRef.current?.contains(sel.anchorNode) ? sel.toString().trim() : '';
    if (picked) return picked;
    try {
      return getContext?.()?.trim() || null;
    } catch {
      return null;
    }
  };
  // A hotkey or openReport() always starts a fresh, empty form on its tab (outliner report 20:55),
  // even right after a send or with another tab half written. A click on the button keeps the draft.
  const openOn = (t?: string, fresh = false) => {
    if (t && extraTabs?.some((x) => x.id === t)) setExtraId(t);
    else if (t && tabs.some((x) => x.value === t)) {
      setType(t as ReportType);
      setExtraId(null);
    }
    const picked = pickContext();
    if (fresh) {
      setText('');
      setFiles([]);
      setVideo(null);
      setError(null);
      setContext(picked || null);
    } else if (picked) setContext(picked);
    if (!open) show();
    else textareaRef.current?.focus();
  };
  const openOnRef = useRef(openOn);
  openOnRef.current = openOn;
  const setUserKeyRef = useRef(setUserKey);
  setUserKeyRef.current = setUserKey;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat) return;
      // Setting a shortcut: the next chord is the new one, Esc cancels.
      const rec = recordingRef.current;
      if (rec) {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          setKeyFor(null);
          return;
        }
        const chord = chordOf(e);
        if (!chord) return;
        e.preventDefault();
        e.stopPropagation();
        setUserKeyRef.current(rec, chord);
        setKeyFor(null);
        return;
      }
      const t = hotkeyType(e, keys);
      if (!t) return;
      e.preventDefault();
      e.stopPropagation();
      openOnRef.current(t, true);
    };
    const onOpen = (e: Event) => openOnRef.current((e as CustomEvent<{ type?: string }>).detail?.type, true);
    const onClose = () => closeRef.current();
    // Capture phase: the page's own key handlers (an editor, a popup) never swallow the chord.
    window.addEventListener('keydown', onKey, true);
    window.addEventListener(OPEN_EVENT, onOpen);
    window.addEventListener(CLOSE_EVENT, onClose);
    return () => {
      window.removeEventListener(CLOSE_EVENT, onClose);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, [keys]);

  const attachVideo = (blob: Blob) => {
    setError(null);
    if (!videoType(blob.type)) {
      setError('Attach a WebM, MP4 or MOV video.');
      return;
    }
    if (blob.size > maxVideoBytes) {
      setError(`That video is ${formatBytes(blob.size)}, over the ${formatBytes(maxVideoBytes)} limit. Record a shorter clip or trim it, or send the report without it.`);
      return;
    }
    setVideo({ blob, preview: URL.createObjectURL(blob) });
  };

  const startRecording = async () => {
    setError(null);
    try {
      recorderRef.current = await recordScreen({
        maxSeconds: lim.maxVideoSeconds,
        maxBytes: maxVideoBytes,
        onTick: setRecording,
        onDone: ({ blob, note }) => {
          recorderRef.current = null;
          setRecording(null);
          setOpen(true);
          if (blob) attachVideo(blob);
          if (note) setError(note);
        },
      });
      setRecording(0);
    } catch (e) {
      setError(shareError(e));
    }
  };

  const close = () => {
    setOpen(false);
    setError(null);
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current === open) return;
    wasOpen.current = open;
    onOpenChangeRef.current?.(open);
  }, [open]);

  // The panel follows its content, growing and shrinking, with a short ease instead of a jump
  // (shipcue report e8b2dedd; it used to only grow).
  useEffect(() => {
    const el = panelRef.current;
    const inner = contentRef.current;
    if (!open || !el || !inner || typeof ResizeObserver === 'undefined') return;
    let frame = 0;
    let first = true;
    // Written on the next frame: changing the size inside the observer's own callback
    // makes the browser report a "ResizeObserver loop" error.
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const cs = getComputedStyle(el);
        const frameSize = ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'].reduce((n, k) => n + (parseFloat(cs[k as 'paddingTop']) || 0), 0);
        el.style.transition = first ? '' : 'height 0.16s ease';
        el.style.height = `${Math.ceil(inner.getBoundingClientRect().height + frameSize)}px`;
        first = false;
      });
    });
    ro.observe(inner);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      el.style.height = '';
      el.style.transition = '';
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Pasted, dropped or picked: a video goes to the video slot, an image is a screenshot, and
  // anything else is a file when the handler takes files (shipcue report e8b2dedd).
  const addFiles = async (incoming: File[]) => {
    setError(null);
    const next = [...files];
    for (const raw of incoming) {
      if (raw.type.startsWith('video/')) {
        if (videoOn) attachVideo(raw);
        else setError('This app does not take videos.');
        continue;
      }
      const isImage = raw.type.startsWith('image/') && raw.type !== 'image/svg+xml';
      if (!isImage && !filesOn) {
        setError(videoOn ? 'Attach screenshots or a video here.' : 'Screenshots must be PNG, JPG, WebP or GIF.');
        continue;
      }
      if (!isImage && (BLOCKED_FILE_TYPES.includes(raw.type) || /\.(html?|svg|js|exe)$/i.test(raw.name))) {
        setError(`${raw.name} cannot be attached.`);
        continue;
      }
      // Retina screenshots are re-encoded smaller in the browser first.
      const f = isImage ? await shrinkImage(raw) : raw;
      if (isImage && !ACCEPT.includes(f.type)) {
        setError('Screenshots must be PNG, JPG, WebP or GIF.');
        continue;
      }
      if (f.size > lim.maxScreenshotBytes) {
        setError(`Each ${isImage ? 'screenshot' : 'file'} must be under ${Math.round(lim.maxScreenshotBytes / 1024 / 1024)} MB.`);
        continue;
      }
      if (next.length >= lim.maxScreenshots) {
        setError(`Up to ${lim.maxScreenshots} screenshots.`);
        break;
      }
      const total = next.reduce((n, x) => n + x.size, 0) + f.size;
      if (total > lim.maxTotalScreenshotBytes) {
        setError(`That is all the screenshots one report can carry (${formatBytes(lim.maxTotalScreenshotBytes)}). Send the rest in another report.`);
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
      form.set('context', context ?? '');
      form.set('priority', priority);
      form.set('area', area);
      form.set('pageUrl', page ?? '');
      form.set('userAgent', navigator.userAgent);
      form.set('diagnostics', snapshot(diagnostics, captureErrors));
      files.forEach((f) => form.append(ACCEPT.includes(f.type) ? 'screenshot' : 'file', f, f.name));
      const result = submit ? await submit(form) : await postTo(endpoint, form);
      if ('error' in result) throw new Error(result.error);
      // The report is filed either way; a failed video upload is said on the thanks screen.
      let videoFailed: string | null = null;
      if (video && videoOn) {
        try {
          await (uploadVideo ? uploadVideo(result.id, video.blob) : postVideo(endpoint, result.id, video.blob));
        } catch (e) {
          videoFailed = videoError(e, video.blob.size, maxVideoBytes);
        }
      }
      setVideo(null);
      setOpen(false);
      setSent({ warning: videoFailed });
      setText('');
      setContext(null);
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
    <div data-shipcue={variant} style={variant === 'floating' ? s.floatingWrap : s.inlineWrap}>
      {open && recording === null && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label={extra ? (extra.title ?? extra.label) : HEADING[type][0]}
          style={variant === 'floating' ? s.panel : s.inlinePanel}
          onDragOver={(e) => {
            if (!extra && e.dataTransfer.types.includes('Files')) e.preventDefault();
          }}
          onDrop={(e) => {
            if (extra || !e.dataTransfer.files.length) return;
            e.preventDefault();
            void addFiles(Array.from(e.dataTransfer.files));
          }}
        >
          <div ref={contentRef}>
          <div style={s.row}>
            <div>
              <h3 style={s.h3}>{extra ? (extra.title ?? extra.label) : HEADING[type][0]}</h3>
              <p style={s.sub}>
                {extra ? (extra.subtitle ?? '') : HEADING[type][1]}
              </p>
            </div>
            <button type="button" onClick={close} aria-label="Close" style={s.iconBtn}>
              ×
            </button>
          </div>

          {(
            <>
              <div role="radiogroup" aria-label="Report type" style={s.segment}>
                {tabs.map((t) => {
                  const on = !extra && type === t.value;
                  return (
                    <button
                      key={t.value}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => {
                        setType(t.value);
                        setExtraId(null);
                      }}
                      title={keys[t.value]?.[0] ? `${t.label} (${display(keys[t.value]![0]!)})` : undefined}
                      style={on ? s.segOn : s.segOff}
                    >
                      {t.label}
                    </button>
                  );
                })}
                {extraTabs?.map((x) => (
                  <button
                    key={x.id}
                    type="button"
                    role="radio"
                    aria-checked={extraId === x.id}
                    onClick={() => setExtraId(x.id)}
                    title={keys[x.id]?.[0] ? `${x.label} (${display(keys[x.id]![0]!)})` : undefined}
                    style={extraId === x.id ? s.segOn : s.segOff}
                  >
                    {x.label}
                  </button>
                ))}
              </div>
              {extra ? (
                <div style={{ marginTop: 12 }}>{extra.render({ text, context, close })}</div>
              ) : (
              <>
              <textarea
                ref={textareaRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    if (canSend) void send();
                  }
                }}
                onPaste={(e) => {
                  const pasted = Array.from(e.clipboardData.files);
                  if (pasted.length) {
                    e.preventDefault();
                    void addFiles(pasted);
                  }
                }}
                rows={4}
                aria-label="Description"
                placeholder={current.placeholder}
                style={s.textarea}
              />
              {context !== null && (
                <div style={{ marginTop: 8 }}>
                  <div style={{ ...s.row, alignItems: 'center' }}>
                    <label htmlFor={`${uid}-context`} style={s.label}>
                      Context
                    </label>
                    <button type="button" onClick={() => setContext(null)} aria-label="Remove context" style={s.linkBtn}>
                      remove
                    </button>
                  </div>
                  <textarea
                    id={`${uid}-context`}
                    value={context}
                    onChange={(e) => setContext(e.target.value)}
                    rows={3}
                    style={{ ...s.textarea, marginTop: 4, fontSize: 12, background: '#fafafa', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
                  />
                </div>
              )}
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
                accept={filesOn ? undefined : [...ACCEPT, ...(videoOn ? ['video/webm', 'video/mp4', 'video/quicktime'] : [])].join(',')}
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files) void addFiles(Array.from(e.target.files));
                  e.target.value = '';
                }}
              />
              <div style={s.thumbs}>
                {previews.map((src, i) => (
                  <div key={(src || files[i]!.name) + i} style={{ position: 'relative' }}>
                    {src ? (
                      <img src={src} alt={`Screenshot ${i + 1}`} style={s.thumb} />
                    ) : (
                      <div title={files[i]!.name} style={{ ...s.thumb, ...s.fileChip }}>
                        <span style={s.fileName}>{files[i]!.name}</span>
                        <span>{formatBytes(files[i]!.size)}</span>
                      </div>
                    )}
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
                {files.length < lim.maxScreenshots && (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    aria-label={filesOn ? 'Add a screenshot or file' : 'Add a screenshot'}
                    title={filesOn ? 'Add a screenshot or file' : 'Add a screenshot'}
                    style={s.addShot}
                  >
                    <svg data-icon="photo" width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <rect x="3" y="5" width="18" height="14" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
                      <circle cx="9" cy="10" r="1.6" stroke="currentColor" strokeWidth="1.6" />
                      <path d="m4 17 5-4.5 3.5 3 2.5-2 5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
                    </svg>
                  </button>
                )}
              </div>
              <p style={s.hint}>
                Paste or drop {filesOn ? 'screenshots, files' : 'screenshots'}
                {videoOn ? ' or a video' : ''} into the text box, or add up to {lim.maxScreenshots}.
              </p>

              {videoOn && (
                <div style={{ ...s.thumbs, alignItems: 'center' }}>
                  {video ? (
                    <div style={{ position: 'relative' }}>
                      <video src={video.preview} controls muted playsInline style={{ height: 72, borderRadius: 6, border: '1px solid #e4e4e7' }} />
                      <button type="button" aria-label="Remove video" onClick={() => setVideo(null)} style={s.remove}>
                        ×
                      </button>
                    </div>
                  ) : (
                    <>
                      {canRecordScreen() && (
                        <button type="button" onClick={startRecording} style={{ ...s.ghost, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                          <svg data-icon="video" width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                            <rect x="2.5" y="6" width="13" height="12" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
                            <path d="m15.5 10.5 5-3v9l-5-3z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                          </svg>
                          Record screen
                        </button>
                      )}
                      <button type="button" onClick={() => videoInputRef.current?.click()} style={s.linkBtn}>
                        or attach a video
                      </button>
                    </>
                  )}
                  {video && <span style={s.hint}>{formatBytes(video.blob.size)}</span>}
                  <input
                    ref={videoInputRef}
                    type="file"
                    aria-label="Attach a video"
                    accept="video/webm,video/mp4,video/quicktime"
                    hidden
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) attachVideo(f);
                      e.target.value = '';
                    }}
                  />
                </div>
              )}

              {error && (
                <p role="alert" style={s.error}>
                  {error}
                </p>
              )}
              {page && (
                <p style={{ ...s.hint, marginTop: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  Page: {decodeURIComponent(new URL(page).pathname)}{' '}
                  <button type="button" onClick={() => setPage(null)} style={s.linkBtn}>
                    don&apos;t attach
                  </button>
                </p>
              )}
              {editingKeys && hotkeys !== false && (
                <div style={s.keysBox} aria-label="Shortcuts">
                  {[...tabs.map((t) => ({ id: t.value as string, label: t.label })), ...(extraTabs ?? []).map((x) => ({ id: x.id, label: x.label }))].map(({ id, label }) => (
                    <div key={id} style={s.keysRow}>
                      <span>{label}</span>
                      <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <kbd style={s.keysKbd}>{keyFor === id ? 'Press keys…' : keys[id]?.[0] ? display(keys[id]![0]!) : 'none'}</kbd>
                        <button type="button" onClick={() => setKeyFor(keyFor === id ? null : id)} style={s.linkBtn}>
                          {keyFor === id ? 'cancel' : 'change'}
                        </button>
                        {userKeys[id] && (
                          <button type="button" onClick={() => setUserKey(id, null)} style={s.linkBtn} title={`Back to ${appKeys[id]?.[0] ? display(appKeys[id]![0]!) : 'none'}`}>
                            reset
                          </button>
                        )}
                      </span>
                    </div>
                  ))}
                  <p style={{ ...s.hint, marginTop: 6 }}>Saved in this browser. Esc cancels.</p>
                </div>
              )}
              <div style={{ ...s.row, alignItems: 'center', marginTop: 12 }}>
                <span style={{ ...s.hint, marginTop: 0 }}>
                  {pastReportsHref && (
                    <a href={pastReportsHref} style={{ color: '#71717a' }}>
                      {pastReportsLabel}
                    </a>
                  )}
                  {pastReportsHref && (hotkeys !== false || onEditShortcuts) && ' · '}
                  {(hotkeys !== false || onEditShortcuts) && (
                    <button
                      type="button"
                      onClick={() => {
                        if (onEditShortcuts) {
                          close();
                          onEditShortcuts();
                          return;
                        }
                        setEditingKeys((v) => !v);
                        setKeyFor(null);
                      }}
                      aria-expanded={onEditShortcuts ? undefined : editingKeys}
                      style={{ ...s.linkBtn, fontSize: 10, textDecoration: 'none', color: '#71717a' }}
                    >
                      Shortcuts
                    </button>
                  )}
                </span>
                <button type="button" onClick={send} disabled={!canSend} style={canSend ? s.send : { ...s.send, opacity: 0.5, cursor: 'not-allowed' }}>
                  {busy ? 'Sending…' : 'Send'}
                  <span style={s.kbd} aria-hidden="true">{isMac() ? '⌘↵' : 'Ctrl+↵'}</span>
                </button>
              </div>
              </>
              )}
            </>
          )}
          {watermark && (
            <p style={s.watermark}>
              Powered by{' '}
              <a href="https://github.com/cyu60/shipcue" target="_blank" rel="noopener noreferrer" style={s.watermarkLink}>
                shipcue
              </a>
              {' · '}
              <a
                href="https://github.com/cyu60/shipcue"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Star shipcue on GitHub"
                style={s.watermarkLink}
              >
                ★ Star it on GitHub
              </a>{' '}
              if it helps
            </p>
          )}
          </div>
        </div>
      )}

      {sent && (
        <div role="status" style={s.sent}>
          {successMessage}
          {pastReportsHref && (
            <>
              {' '}
              <a href={pastReportsHref} style={{ color: 'inherit', fontWeight: 600 }}>
                {seeReportsLabel}
              </a>
            </>
          )}
          {sent.warning && <p style={{ margin: '4px 0 0', color: '#be123c' }}>The video was not attached: {sent.warning}</p>}
        </div>
      )}
      {recording !== null && (
        <button type="button" onClick={() => recorderRef.current?.stop()} aria-label="Stop recording" title="Stop recording and attach it to the report" style={s.recording}>
          ● {Math.floor(recording / 60)}:{String(recording % 60).padStart(2, '0')}
        </button>
      )}
      {trigger !== false && (
        <button
          type="button"
          onClick={() => (open ? close() : openOn())}
          aria-label={open ? 'Close report' : 'Report a bug or request a feature'}
          title="Report a bug or request a feature"
          style={variant === 'floating' ? s.fab : s.inlineBtn}
        >
          <svg data-icon="ship" width={variant === 'floating' ? 22 : 18} height={variant === 'floating' ? 22 : 18} viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 3v12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            <path d="M12 4.5 18 13h-6z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
            <path d="M12 7.5 7 13h5" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
            <path d="M3 15.5h18l-2.2 3.9a2 2 0 0 1-1.74 1.1H6.94a2 2 0 0 1-1.74-1.1z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
          </svg>
        </button>
      )}
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
  // Small, quiet tabs and buttons (Chinat preferred these over bigger, bolder ones).
  const seg: CSSProperties = { flex: 1, border: 0, borderRadius: 6, padding: '4px 8px', fontSize: 12, fontWeight: 500, fontFamily: font, cursor: 'pointer', whiteSpace: 'nowrap' };
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
    h3: { margin: 0, fontSize: 14, fontWeight: 600, fontFamily: font, lineHeight: 1.3, letterSpacing: 'normal', color: '#18181b' } as CSSProperties,
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
    kbd: { marginLeft: 6, fontSize: 10, opacity: 0.7, fontWeight: 400 } as CSSProperties,
    watermark: { margin: '12px 0 0', textAlign: 'center', fontSize: 10, color: '#a1a1aa', fontFamily: font } as CSSProperties,
    watermarkLink: { color: '#71717a', textDecoration: 'none', fontWeight: 600 } as CSSProperties,
    thumbs: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 } as CSSProperties,
    fileChip: { display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 2, padding: 4, fontSize: 9, color: '#71717a', background: '#fafafa', textAlign: 'center', overflow: 'hidden' } as CSSProperties,
    fileName: { color: '#3f3f46', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as CSSProperties,
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
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 0,
      cursor: 'pointer',
    } as CSSProperties,
    sent: { background: '#fff', color: '#18181b', border: '1px solid #e4e4e7', borderRadius: 12, padding: '10px 14px', fontSize: 13, fontFamily: font, boxShadow: '0 8px 24px rgba(24,24,27,0.12)', maxWidth: 320 } as CSSProperties,
    error: { marginTop: 8, borderRadius: 8, background: '#fff1f2', color: '#be123c', padding: '8px 12px', fontSize: 12 } as CSSProperties,
    ghost: { border: '1px solid #d4d4d8', borderRadius: 8, background: '#fff', color: '#3f3f46', padding: '4px 10px', fontSize: 12, fontWeight: 500, fontFamily: font, cursor: 'pointer' } as CSSProperties,
    keysBox: { marginTop: 10, padding: '8px 10px', border: '1px solid #e4e4e7', borderRadius: 8, fontSize: 11, color: '#3f3f46', fontFamily: font } as CSSProperties,
    keysRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '3px 0' } as CSSProperties,
    keysKbd: { minWidth: 44, textAlign: 'center', padding: '1px 6px', border: '1px solid #e4e4e7', borderRadius: 4, background: '#fafafa', fontSize: 10, fontFamily: 'inherit' } as CSSProperties,
    linkBtn: { border: 0, background: 'transparent', color: '#71717a', padding: 0, fontSize: 11, textDecoration: 'underline', cursor: 'pointer' } as CSSProperties,
    recording: { border: 0, borderRadius: 999, background: '#e11d48', color: '#fff', padding: '8px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' } as CSSProperties,
    send: { border: 0, borderRadius: 8, background: accent, color: '#fff', padding: '6px 12px', fontSize: 14, fontWeight: 500, fontFamily: font, cursor: 'pointer' } as CSSProperties,
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
