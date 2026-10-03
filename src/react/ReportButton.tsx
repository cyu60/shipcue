'use client';

import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { chordOf, CLOSE_EVENT, defaultHotkeys, display, hotkeyType, isMac, loadUserHotkeys, OPEN_EVENT, saveUserHotkeys, SELECT_AREA_EVENT, type Hotkeys } from './hotkeys';
import { useLightbox } from './Lightbox';
import { PinIcon } from './PinIcon';
import { loadStars, rememberMine, starredFirst, toggleStar, useStars } from './stars';
import { BUTTON_PX, RESIZE, SIZES, TEXT_ZOOM, loadAppearance, loadPanelSize, saveAppearance, savePanelSize, type Appearance, type PanelSize, type Size } from './appearance';
import { BLOCKED_FILE_TYPES, formatBytes, PRIORITIES, PRIORITY_HINT, PRIORITY_LABEL, resolveConfig, videoType, type Area, type Capabilities, type Limits, type Priority, type ReportType } from '../core';
import { captureErrors as startCapturingErrors, recentErrors } from './errors';
import { shrinkImage } from './shrink';
import { isOutlineText, OutlinePreview } from './outline';
import { fill, resolveText, type ShipcueText } from './text';
import { canRecordScreen, recordScreen, shareError, type ScreenRecording } from './video';
import { afterPaint, CAPTURE_KEEP_ALIVE_MS, canCaptureTab, captureError, tabCapture, type Rect, type TabCapture } from './capture';
import { AreaSelect } from './AreaSelect';
import { Annotator } from './Annotator';
import { agentPrompt, type AgentPromptAuth } from './agentPrompt';

/** signIn: where to sign in, when the handler wants that before it takes more (anonymousLimit). */
export type SubmitResult = { id: string } | { error: string; signIn?: string | null };

export interface ReportButtonProps {
  /** The parts of your app a report can be about. "Other" is always added. */
  areas?: Area[];
  /** Where createShipcueHandler is mounted. Ignored when `submit` is given. */
  endpoint?: string;
  /** Send the form yourself, e.g. through a Next.js server action. */
  submit?: (form: FormData) => Promise<SubmitResult>;
  /**
   * Who is signed in on your site (an email or a name), sent with each report in the
   * `x-shipcue-user` header. shipcue Cloud shows it as the reporter; your own handler can read it
   * in `getReporter`. Your site vouches for it: shipcue cannot check it.
   */
  reporter?: string;
  /** A snapshot of app state attached to every report, for whoever fixes it. Keep it under 64 KB. */
  diagnostics?: () => Record<string, unknown>;
  /** `floating`: bottom-right bubble. `inline`: a small button for a header or toolbar. */
  variant?: 'floating' | 'inline';
  /** Button and focus colour. */
  accentColor?: string;
  /** Shown after a report is sent, e.g. a link to your queue. Same as text.sent, but can be any node. */
  successMessage?: React.ReactNode;
  /**
   * Your own words for anything the panel says: tab names, headings, placeholders, buttons,
   * links, the thanks note. Leave out what you are happy with; see DEFAULT_TEXT.
   */
  text?: Partial<ShipcueText>;
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
  /**
   * The small Pin button next to Dictate: a pinned report stays at the top of Yours and the
   * CueLog, and the form sends pinned=1 so your own backend can keep it too. On by default; turn
   * it off if your app has its own pin control (say through formExtras).
   */
  pin?: boolean;
  /**
   * When your endpoint needs auth (say a Bearer API token), so "Copy prompt for my agent" tells
   * the agent: the header goes on its curl, the token on its claude mcp add line, and `where` says
   * where to get one. Never put a real token here; it is copied into the prompt as written.
   */
  agentPromptAuth?: AgentPromptAuth;
  /** The floating button's size; each person can change it in the panel's Display settings. */
  buttonSize?: Size;
  /** How big the panel's text is; each person can change it in the panel's Display settings. */
  textSize?: Size;
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
   * Draw the Context's Preview your own way, e.g. your app's outline renderer. Without it,
   * shipcue draws bullets, nesting, [[links]], #tags and ((refs)) itself.
   */
  renderContext?: (text: string) => React.ReactNode;
  /**
   * false draws no button of its own: open the panel from your existing menu or help button with
   * openReport(), or with the hotkeys.
   */
  trigger?: boolean;
  /**
   * Your own mark on the button in place of shipcue's sailboat, e.g. your app's logo (about 22px
   * on the floating button, 18px inline). The button keeps its accent background.
   */
  launcherIcon?: React.ReactNode;
  /** shipcue's own mark on the button: the hard hat (default) or the original sailboat. */
  icon?: 'hat' | 'ship';
  /**
   * People can drag the floating button anywhere on the page, by the button or by the panel's
   * title (the two move together); where they leave it is kept in their browser (Reset position,
   * or ⌃⇧H, puts it back). On by default; false pins it in place.
   */
  movable?: boolean;
  /**
   * People can resize the floating panel by the small grip on its free corner (the one away from
   * the button), or with the arrow keys once the grip is focused; the text box takes the extra
   * height (shipcue report ee970b18). Kept in their browser; Reset position puts it back. On by
   * default, also with movable={false}; false keeps the default size. The inline variant has none.
   */
  resizable?: boolean;
  /**
   * Hide shipcue (button and hotkeys) unless the page is opened with ?<showParam>=true, e.g.
   * showParam="shipcue" for ?shipcue=true. Remembered for the tab; ?shipcue=false hides it again.
   * Unset (the default): always shown.
   */
  showParam?: string;
  /**
   * Your own small controls in the Bug and Feature request form, e.g. a "Pin it" checkbox. Drawn
   * under the text box, in the panel's quiet style; keep it to a line.
   */
  formExtras?: React.ReactNode;
  /**
   * Extra fields sent with each report, read the moment it is sent, e.g. () => ({ pinned: '1' }).
   * They never replace shipcue's own fields (description, type, context, ...).
   */
  fields?: () => Record<string, string>;
  /**
   * Area capture comes with the panel (shipcue report 503aa011): while it is open the page is
   * tinted, and a drag anywhere on the tint captures that part of the page into the annotator, as
   * Select area does, with no hotkey or button. A plain click (or tap) on the tint, or Esc, lifts
   * it so the page is usable again (copy text into the report); the Select area tile or its hotkey
   * brings capture back. The panel and button stay above it, and typing in the panel never
   * captures. On by default for the floating panel (also with trigger={false}); off for the inline
   * variant unless set. false keeps the panel as it was before 0.21.
   */
  captureOnOpen?: boolean;
  /**
   * How long (ms) the tab share the browser granted for a capture is kept for the next one while
   * the panel is open (shipcue report 03de1f12), so Chrome asks once per session rather than on
   * every capture. Sharing always stops when the panel closes or the page is hidden. 0 stops it
   * after each capture. Default 120000 (two minutes).
   */
  captureKeepAlive?: number;
  /**
   * Deprecated since 0.21 in favour of captureOnOpen. Tints the page while the panel is open,
   * without blocking it (shipcue report 58b727d9). With captureOnOpen on, this plain tint shows
   * only once the capture tint is lifted. Off by default.
   */
  dimOnOpen?: boolean;
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

const typesFor = (t: ShipcueText): { value: ReportType; label: string; placeholder: string }[] => [
  { value: 'bug', label: t.bugTab, placeholder: t.bugPlaceholder },
  { value: 'feature', label: t.featureTab, placeholder: t.featurePlaceholder },
  { value: 'task', label: t.taskTab, placeholder: t.taskPlaceholder },
];
const headingFor = (t: ShipcueText): Record<ReportType, [string, string]> => ({
  bug: [t.bugTitle, t.bugSubtitle],
  feature: [t.featureTitle, t.featureSubtitle],
  task: [t.taskTitle, t.taskSubtitle],
});

const ACCEPT = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/** The header that says who is filing, when the app told us. */
const reporterHeaders = (reporter: string | undefined): Record<string, string> => (reporter ? { 'x-shipcue-user': reporter } : {});

async function postTo(endpoint: string, form: FormData, reporter?: string): Promise<SubmitResult> {
  const res = await fetch(`${endpoint.replace(/\/$/, '')}/reports`, { method: 'POST', body: form, headers: reporterHeaders(reporter) });
  const body = (await res.json().catch(() => ({}))) as Partial<{ id: string; error: string; signIn: string | null }>;
  if (res.ok && body.id) return { id: body.id };
  return { error: body.error ?? 'Could not send the report. Please try again.', signIn: body.signIn ?? null };
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

async function postVideo(endpoint: string, reportId: string, video: Blob, reporter?: string): Promise<void> {
  const form = new FormData();
  form.set('video', video, `video.${videoType(video.type) === 'video/mp4' ? 'mp4' : videoType(video.type) === 'video/quicktime' ? 'mov' : 'webm'}`);
  const res = await fetch(`${endpoint.replace(/\/$/, '')}/reports/${reportId}/video`, { method: 'POST', body: form, headers: reporterHeaders(reporter) });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    // A host's own limit (Vercel: 4.5 MB per request) answers before the handler does.
    if (res.status === 413) throw new Error(`The video (${formatBytes(video.size)}) is too big for this app to take. Try a shorter one.`);
    throw new Error(body.error ?? (res.status === 404 ? 'This app does not take videos.' : 'Could not upload the video.'));
  }
}

function ReportPanel({
  areas,
  endpoint: endpointProp,
  submit,
  reporter,
  diagnostics,
  variant = 'floating',
  accentColor = '#18181b',
  successMessage,
  text: textProp,
  onSubmitted,
  uploadVideo,
  captureErrors = true,
  pastReportsHref,
  pastReportsLabel,
  seeReportsLabel,
  limits,
  onEditShortcuts,
  pin = true,
  agentPromptAuth,
  buttonSize: buttonSizeProp = 'medium',
  textSize: textSizeProp = 'medium',
  watermark = true,
  types,
  hotkeys,
  getContext,
  onOpenChange,
  extraTabs,
  renderContext,
  trigger = true,
  launcherIcon,
  icon = 'hat',
  movable = true,
  resizable = true,
  formExtras,
  fields,
  dimOnOpen = false,
  captureOnOpen: captureOnOpenProp,
  captureKeepAlive = CAPTURE_KEEP_ALIVE_MS,
}: ReportButtonProps) {
  const captureOnOpen = captureOnOpenProp ?? variant === 'floating';
  const endpoint = endpointProp ?? '/api/shipcue';
  // The app's words over shipcue's (the older pastReportsLabel/seeReportsLabel props still work).
  const t = useMemo(
    () => resolveText({ pastReports: pastReportsLabel, seeReports: seeReportsLabel }, textProp),
    [pastReportsLabel, seeReportsLabel, textProp],
  );
  const TYPES = useMemo(() => typesFor(t), [t]);
  const HEADING = useMemo(() => headingFor(t), [t]);
  const tabs = useMemo(() => (types?.length ? TYPES.filter((x) => types.includes(x.value)) : TYPES), [types, TYPES]);
  const config = useMemo(() => resolveConfig({ areas }), [areas]);
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  openRef.current = open;
  const [text, setText] = useState('');
  const [context, setContext] = useState<string | null>(null);
  // Preview (an outline) or Raw (the editable text) for the Context box (shipcue report 0fcc360a).
  const [contextView, setContextView] = useState<'preview' | 'raw'>('preview');
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
  // Select an area, capture it, mark it up (shipcue report 58b727d9). Alt text per screenshot.
  const [selecting, setSelecting] = useState(false);
  // The capture tint (captureOnOpen) was lifted by a click or Esc; each opening brings it back.
  const [tintLifted, setTintLifted] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset per opening
    if (open) setTintLifted(false);
  }, [open]);
  const ambientRef = useRef(false);
  const [capturing, setCapturing] = useState(false);
  const [annotating, setAnnotating] = useState<{ src: string; index: number | null; alt: string; name: string; own: boolean } | null>(null);
  const [alts, setAlts] = useState<Map<File, string>>(() => new Map());
  const annotatingRef = useRef(annotating);
  annotatingRef.current = annotating;
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
          ...(known.maxAltText ? { maxAltText: known.maxAltText } : {}),
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
  // Dictation (shipcue report 77a47290): the browser's own speech recognition, so no audio leaves
  // the page through shipcue. Hidden where the browser has none (Firefox).
  const [speech, setSpeech] = useState(false);
  useEffect(() => {
    const w = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
    // eslint-disable-next-line react-hooks/set-state-in-effect -- only known in the browser
    setSpeech(!!(w.SpeechRecognition || w.webkitSpeechRecognition));
  }, []);
  const [listening, setListening] = useState(false);
  const textRef = useRef('');
  textRef.current = text;
  const recognitionRef = useRef<{ stop(): void; abort(): void } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  // While open, the panel never shrinks back (switching tabs, clearing text), so it does not jump.
  const contentRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const previews = useMemo(() => files.map((f) => (ACCEPT.includes(f.type) ? URL.createObjectURL(f) : '')), [files]);
  useEffect(() => () => previews.forEach((u) => u && URL.revokeObjectURL(u)), [previews]);

  useEffect(() => {
    const el = textareaRef.current;
    // Not from under the annotator, which has the keys while it is open.
    if (!open || !el || annotatingRef.current) return;
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
  // The floating widget can be dragged (by the button, or the panel's title), so it can be put back.
  const canMove = variant === 'floating' && movable;
  const canResize = variant === 'floating' && resizable;
  const [appearance, setAppearanceState] = useState<Appearance>({});
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is only there in the browser
    setAppearanceState(loadAppearance());
  }, []);
  const setAppearance = (next: Appearance) => {
    setAppearanceState(next);
    saveAppearance(next);
  };
  const buttonPx = BUTTON_PX[appearance.buttonSize ?? buttonSizeProp];
  const textZoom = TEXT_ZOOM[appearance.textSize ?? textSizeProp];
  const resize = usePanelResize(canResize, panelRef, textZoom);
  const panelSize = resize.size;
  const [editingDisplay, setEditingDisplay] = useState(false);
  const [anonymous, setAnonymous] = useState(false);
  // Pin the report being written, so it stays at the top of Yours and the CueLog (report a346d199).
  const [pinNext, setPinNext] = useState(false);
  const [signInHref, setSignInHref] = useState<string | null>(null);
  const lightbox = useLightbox();
  const starState = useStars();
  const [showMine, setShowMine] = useState(false);
  const resetPositionRef = useRef<() => void>(() => undefined);
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
    const ids = [...tabs.map((t) => t.value as string), ...(extraTabs ?? []).map((x) => x.id), ...(speech ? ['dictate'] : []), ...(canMove || canResize ? ['resetPosition'] : []), 'selectArea'];
    return Object.fromEntries(ids.map((id) => [id, (all as Hotkeys)[id] ?? []]));
  }, [hotkeys, appKeys, userKeys, tabs, extraTabs, speech, canMove, canResize]);

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
      setContextView('preview');
    } else if (picked) {
      setContext(picked);
      setContextView('preview');
    }
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
      if (t === 'resetPosition') {
        resetPositionRef.current();
        return;
      }
      if (t === 'selectArea') {
        startSelectRef.current();
        return;
      }
      if (t === 'dictate') {
        // Open the panel where it was (or keep it open), then listen.
        if (!openRef.current) openOnRef.current(undefined, false);
        setTimeout(() => toggleDictationRef.current(), 0);
        return;
      }
      openOnRef.current(t, true);
    };
    const onOpen = (e: Event) => openOnRef.current((e as CustomEvent<{ type?: string }>).detail?.type, true);
    const onClose = () => closeRef.current();
    // Capture phase: the page's own key handlers (an editor, a popup) never swallow the chord.
    window.addEventListener('keydown', onKey, true);
    // selectArea() from the app (a command palette, say): Select area, as the tile does.
    const onSelectArea = () => startSelectRef.current();
    window.addEventListener(OPEN_EVENT, onOpen);
    window.addEventListener(CLOSE_EVENT, onClose);
    window.addEventListener(SELECT_AREA_EVENT, onSelectArea);
    return () => {
      window.removeEventListener(SELECT_AREA_EVENT, onSelectArea);
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

  const stopDictation = () => {
    recognitionRef.current?.stop();
  };
  // Words go into the text box as you speak, after whatever was there.
  const startDictation = () => {
    const w = window as unknown as { SpeechRecognition?: new () => SpeechLike; webkitSpeechRecognition?: new () => SpeechLike };
    const SR = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!SR || recognitionRef.current) return;
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || 'en-US';
    const before = textRef.current.trimEnd();
    rec.onresult = (e) => {
      let said = '';
      for (let i = 0; i < e.results.length; i++) said += e.results[i]![0]!.transcript;
      said = said.trim();
      setText(before && said ? `${before} ${said}` : before || said);
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') setError(t.micBlocked);
    };
    rec.onend = () => {
      recognitionRef.current = null;
      setListening(false);
      textareaRef.current?.focus();
    };
    recognitionRef.current = rec;
    setError(null);
    setListening(true);
    try {
      rec.start();
    } catch {
      recognitionRef.current = null;
      setListening(false);
    }
  };
  const toggleDictation = () => (recognitionRef.current ? stopDictation() : startDictation());
  const toggleDictationRef = useRef(toggleDictation);
  toggleDictationRef.current = toggleDictation;

  const close = () => {
    recognitionRef.current?.abort();
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
  // (shipcue report e8b2dedd; it used to only grow). A resized panel (report ee970b18) is sized by
  // CSS instead: at least the chosen height, more when the content needs it.
  const sized = canResize && panelSize !== null;
  useEffect(() => {
    const el = panelRef.current;
    const inner = contentRef.current;
    if (!open || sized || !el || !inner || typeof ResizeObserver === 'undefined') return;
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
  }, [open, sized]);

  useEffect(() => {
    if (!open) return;
    // Esc lifts the capture tint first; the next one closes the panel.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (ambientRef.current) setTintLifted(true);
      else close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Pasted, dropped or picked: a video goes to the video slot, an image is a screenshot, and
  // anything else is a file when the handler takes files (shipcue report e8b2dedd).
  // `replace`: the index of a screenshot the annotator edited, swapped in place; `alt` its alt text.
  const addFiles = async (incoming: File[], opts: { alt?: string; replace?: number } = {}) => {
    setError(null);
    const replaced = opts.replace !== undefined ? files[opts.replace] : undefined;
    const next = replaced ? files.filter((f) => f !== replaced) : [...files];
    const before = next.length;
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
      if (opts.alt !== undefined && isImage) setAlts((m) => new Map(m).set(f, opts.alt!));
    }
    // An edited screenshot goes back where it was; if it could not be taken, the original stays.
    if (replaced && opts.replace !== undefined) {
      if (next.length > before) next.splice(opts.replace, 0, next.pop()!);
      else next.splice(opts.replace, 0, replaced);
    }
    setFiles(next);
  };

  const startSelect = () => {
    setError(null);
    if (!canCaptureTab()) {
      setError(t.captureUnsupported);
      if (!openRef.current) show();
      return;
    }
    recognitionRef.current?.abort();
    if (!openRef.current) setPage(window.location.href);
    setTintLifted(true);
    setSelecting(true);
  };
  const startSelectRef = useRef(startSelect);
  startSelectRef.current = startSelect;

  // One tab share for the open panel (shipcue report 03de1f12): asked for at the first capture,
  // reused after, stopped when the panel closes, the page hides, or captureKeepAlive runs out.
  const tabRef = useRef<{ keepAlive: number; capture: TabCapture } | null>(null);
  const tab = () => {
    if (tabRef.current?.keepAlive !== captureKeepAlive) {
      tabRef.current?.capture.stop();
      tabRef.current = { keepAlive: captureKeepAlive, capture: tabCapture({ keepAliveMs: captureKeepAlive }) };
    }
    return tabRef.current.capture;
  };
  useEffect(() => {
    if (!open) tabRef.current?.capture.stop();
  }, [open]);
  useEffect(() => {
    const onHide = () => document.visibilityState === 'hidden' && tabRef.current?.capture.stop();
    document.addEventListener('visibilitychange', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      tabRef.current?.capture.stop();
    };
  }, []);

  // The tint, the selection and its toolbar, and the panel are gone before the frame is taken,
  // so none of them is in the picture. Capture attaches it; Capture & annotate opens the annotator.
  const captureSelection = async (rect: Rect, { annotate }: { annotate: boolean }) => {
    setSelecting(false);
    // Back at the panel afterwards with the page usable; Select area captures another.
    setTintLifted(true);
    setCapturing(true);
    try {
      await afterPaint();
      const blob = await tab().grab(rect);
      if (annotate) setAnnotating({ src: URL.createObjectURL(blob), index: null, alt: '', name: 'area.png', own: true });
      else await addFiles([new File([blob], 'area.png', { type: 'image/png' })]);
    } catch (e) {
      const problem = captureError(e);
      if (problem) setError(problem === 'declined' ? t.captureDeclined : problem === 'unsupported' ? t.captureUnsupported : t.captureFailed);
    } finally {
      setCapturing(false);
      setSent(null);
      setOpen(true);
    }
  };

  const finishAnnotating = (blob: Blob | null, alt = '') => {
    const a = annotating;
    setAnnotating(null);
    if (!a) return;
    if (a.own) URL.revokeObjectURL(a.src);
    if (!blob) return;
    const name = a.name.replace(/\.[a-z0-9]+$/i, '') + '.png';
    void addFiles([new File([blob], name, { type: 'image/png' })], { alt, ...(a.index !== null ? { replace: a.index } : {}) });
  };

  const send = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setSignInHref(null);
    try {
      const form = new FormData();
      if (anonymous && known?.signedIn) form.set('anonymous', '1');
      if (pin && pinNext) form.set('pinned', '1');
      form.set('type', type);
      form.set('description', text);
      form.set('context', context ?? '');
      form.set('priority', priority);
      form.set('area', area);
      form.set('pageUrl', page ?? '');
      form.set('userAgent', navigator.userAgent);
      form.set('diagnostics', snapshot(diagnostics, captureErrors));
      files.forEach((f) => form.append(ACCEPT.includes(f.type) ? 'screenshot' : 'file', f, f.name));
      // Alt text, one per screenshot in the same order, when any has some (shipcue report 58b727d9).
      const shots = files.filter((f) => ACCEPT.includes(f.type));
      if (shots.some((f) => alts.get(f)?.trim())) shots.forEach((f) => form.append('screenshotAlt', alts.get(f)?.trim() ?? ''));
      for (const [key, value] of Object.entries(fields?.() ?? {})) if (!form.has(key)) form.set(key, value);
      const result = submit ? await submit(form) : await postTo(endpoint, form, reporter);
      if ('error' in result) {
        if (result.signIn) setSignInHref(result.signIn);
        throw new Error(result.error);
      }
      // The report is filed either way; a failed video upload is said on the thanks screen.
      let videoFailed: string | null = null;
      if (video && videoOn) {
        try {
          await (uploadVideo ? uploadVideo(result.id, video.blob) : postVideo(endpoint, result.id, video.blob, reporter));
        } catch (e) {
          videoFailed = videoError(e, video.blob.size, maxVideoBytes);
        }
      }
      setVideo(null);
      rememberMine({ id: result.id, type: extra ? extra.id : type, title: (text.trim().split('\n')[0] ?? '').slice(0, 120), at: new Date().toISOString() });
      if (pin && pinNext && !loadStars().includes(result.id)) toggleStar(result.id);
      setPinNext(false);
      setOpen(false);
      setSent({ warning: videoFailed });
      setText('');
      setContext(null);
      setFiles([]);
      setAlts(new Map());
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
  const drag = useDraggableWidget(canMove, buttonPx, wrapRef);
  // Reset position also forgets the panel's size (shipcue report ee970b18).
  const resetPosition = () => {
    drag.reset();
    resize.reset();
  };
  resetPositionRef.current = resetPosition;
  // The prompt needs somewhere to send the report: the handler, or an endpoint the app named.
  const canCopyPrompt = !submit || endpointProp !== undefined;
  const [promptCopied, setPromptCopied] = useState(false);
  useEffect(() => {
    if (!promptCopied) return;
    const id = setTimeout(() => setPromptCopied(false), 2000);
    return () => clearTimeout(id);
  }, [promptCopied]);
  const copyAgentPrompt = async () => {
    const prompt = agentPrompt({
      app: document.title.trim() || window.location.host,
      pageUrl: page,
      endpoint: new URL(endpoint, window.location.href).href.replace(/\/$/, ''),
      type,
      types: tabs.map((x) => x.value),
      priority,
      area,
      areas: config.areas,
      text,
      context,
      diagnostics: snapshot(diagnostics, captureErrors),
      auth: agentPromptAuth,
      reporter,
    });
    try {
      await navigator.clipboard.writeText(prompt);
      setPromptCopied(true);
    } catch {
      setError(t.copyFailed);
    }
  };

  // The capture tint: only over the report form, while it can still take a screenshot.
  const ambient =
    captureOnOpen && open && !tintLifted && recording === null && !selecting && !capturing && !annotating && !extra && files.length < lim.maxScreenshots && canCaptureTab();
  ambientRef.current = ambient;

  return (
    <div ref={wrapRef} data-shipcue={variant} style={{ ...(variant === 'floating' ? { ...s.floatingWrap, ...drag.wrapStyle } : s.inlineWrap), ...(selecting || capturing ? { visibility: 'hidden' } : null) }}>
      {ambient && typeof document !== 'undefined' && (
        <AreaSelect ambient hint={t.captureOnOpenHint} text={t} onSelect={(r, o) => void captureSelection(r, o)} onCancel={() => setTintLifted(true)} onDismiss={() => setTintLifted(true)} />
      )}
      {dimOnOpen && open && !ambient && !selecting && !capturing && typeof document !== 'undefined' && createPortal(<div data-shipcue-dim="" aria-hidden="true" style={s.dim} />, document.body)}
      {selecting && <AreaSelect hint={t.selectAreaHint} text={t} onSelect={(r, o) => void captureSelection(r, o)} onCancel={() => setSelecting(false)} />}
      {annotating && (
        <Annotator
          src={annotating.src}
          alt={annotating.alt}
          maxAlt={lim.maxAltText}
          text={t}
          zoom={textZoom}
          onCancel={() => finishAnnotating(null)}
          onSave={(blob, alt) => finishAnnotating(blob, alt)}
        />
      )}
      {open && recording === null && !selecting && !capturing && (
        <ResizeBox on={canResize} grip={resize.grip(drag.corner, t.resizePanel)}>
        <div
          ref={panelRef}
          role="dialog"
          aria-label={extra ? (extra.title ?? extra.label) : HEADING[type][0]}
          style={{ ...(variant === 'floating' ? s.panel : s.inlinePanel), ...resize.panelStyle, ...(textZoom !== 1 ? { zoom: textZoom } : null) }}
          onDragOver={(e) => {
            if (!extra && e.dataTransfer.types.includes('Files')) e.preventDefault();
          }}
          onDrop={(e) => {
            if (extra || !e.dataTransfer.files.length) return;
            e.preventDefault();
            void addFiles(Array.from(e.dataTransfer.files));
          }}
        >
          <div ref={contentRef} style={sized ? s.grow : undefined}>
          <div style={{ ...s.row, ...drag.handleStyle }} {...drag.panelHandlers} title={canMove ? t.dragPanel : undefined}>
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
                style={sized ? { ...s.textarea, flex: '1 0 auto' } : s.textarea}
              />
              <div style={{ ...s.row, alignItems: 'center', marginTop: 6, minHeight: 18 }}>
              {context === null && (
                // Add context by hand on any tab (Habitect report 17748c25): what the app says is
                // selected if anything, else an empty box to type or paste into.
                <button
                  type="button"
                  style={{ ...s.linkBtn, textDecoration: 'none' }}
                  onClick={() => {
                    let picked: string | null = null;
                    try {
                      picked = getContext?.()?.trim() || null;
                    } catch {
                      picked = null;
                    }
                    setContext(picked ?? '');
                    setContextView(picked ? 'preview' : 'raw');
                    if (!picked) setTimeout(() => document.getElementById(`${uid}-context`)?.focus(), 0);
                  }}
                >
                  {t.addContext}
                </button>
              )}
                {context !== null && <span />}
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                  {pin && (
                  <button
                    type="button"
                    onClick={() => setPinNext((v) => !v)}
                    aria-pressed={pinNext}
                    aria-label={pinNext ? t.unpinIt : t.pinIt}
                    title={t.pinHint}
                    style={{ ...s.linkBtn, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4, color: pinNext ? '#18181b' : '#71717a', fontWeight: pinNext ? 600 : undefined }}
                  >
                    <PinIcon on={pinNext} size={12} />
                    {pinNext ? t.pinned : t.pin}
                  </button>
                  )}
                  {speech && (
                    <button
                      type="button"
                      onClick={toggleDictation}
                      aria-pressed={listening}
                      title={`${t.dictate}${keys.dictate?.[0] ? ` (${display(keys.dictate[0]!)})` : ''}`}
                      style={{ ...s.linkBtn, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4, color: listening ? '#be123c' : '#71717a' }}
                    >
                      {listening ? (
                        <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: 999, background: '#e11d48' }} />
                      ) : (
                        <svg data-icon="mic" width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                          <rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="1.8" />
                          <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                        </svg>
                      )}
                      {listening ? t.listening : t.dictate}
                      {!listening && keys.dictate?.[0] && <span style={{ opacity: 0.7 }}>{display(keys.dictate[0]!)}</span>}
                    </button>
                  )}
                </span>
              </div>
              {context !== null && (() => {
                // A bulleted outline opens as a Preview; plain text, or anything being edited, as Raw.
                const showPreview = contextView === 'preview' && (!!renderContext || isOutlineText(context));
                return (
                <div style={{ marginTop: 8 }}>
                  <div style={{ ...s.row, alignItems: 'center' }}>
                    <label htmlFor={`${uid}-context`} style={s.label}>
                      {t.context}
                    </label>
                    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                      <span role="radiogroup" aria-label="Show the context as" style={{ fontSize: 11 }}>
                        {(['preview', 'raw'] as const).map((v, i) => (
                          <span key={v}>
                            {i > 0 && <span aria-hidden="true" style={{ color: '#d4d4d8' }}>/</span>}
                            <button
                              type="button"
                              role="radio"
                              aria-checked={v === 'preview' ? showPreview : !showPreview}
                              onClick={() => setContextView(v)}
                              style={{ ...s.linkBtn, textDecoration: 'none', padding: '0 3px', color: (v === 'preview') === showPreview ? '#18181b' : '#a1a1aa', fontWeight: (v === 'preview') === showPreview ? 600 : 400 }}
                            >
                              {v === 'preview' ? t.preview : t.raw}
                            </button>
                          </span>
                        ))}
                      </span>
                      <button type="button" onClick={() => setContext(null)} aria-label="Remove context" style={s.linkBtn}>
                        {t.remove}
                      </button>
                    </span>
                  </div>
                  {showPreview ? (
                    <div aria-label="Context preview" style={s.contextPreview}>
                      {renderContext ? renderContext(context) : <OutlinePreview text={context} />}
                    </div>
                  ) : (
                    <textarea
                      id={`${uid}-context`}
                      value={context}
                      onChange={(e) => setContext(e.target.value)}
                      rows={3}
                      style={{ ...s.textarea, marginTop: 4, fontSize: 12, background: '#fafafa', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
                    />
                  )}
                </div>
                );
              })()}
              <div style={s.grid}>
                <div>
                  <label htmlFor={`${uid}-priority`} style={s.label}>
                    {t.priority}
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
                    {t.where}
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
                      <button
                        type="button"
                        aria-label={`Preview screenshot ${i + 1}`}
                        onClick={() => {
                          const shown = previews.map((p, j) => ({ p, alt: alts.get(files[j]!) })).filter((x) => x.p);
                          lightbox.open(shown.map((x) => x.p), shown.findIndex((x) => x.p === src), shown.map((x) => x.alt));
                        }}
                        style={{ padding: 0, border: 0, background: 'none', cursor: 'zoom-in', display: 'block' }}
                      >
                        <img src={src} alt={alts.get(files[i]!) || `Screenshot ${i + 1}`} style={s.thumb} />
                      </button>
                    ) : (
                      <div title={files[i]!.name} style={{ ...s.thumb, ...s.fileChip }}>
                        <span style={s.fileName}>{files[i]!.name}</span>
                        <span>{formatBytes(files[i]!.size)}</span>
                      </div>
                    )}
                    {src && (
                      // Open it in the annotator again (shipcue report 58b727d9).
                      <button
                        type="button"
                        aria-label={`${t.editScreenshot} screenshot ${i + 1}`}
                        title={t.editScreenshot}
                        onClick={() => setAnnotating({ src, index: i, alt: alts.get(files[i]!) ?? '', name: files[i]!.name, own: false })}
                        style={s.edit}
                      >
                        <svg data-icon="pencil" width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                          <path d="M4 20h4L19 9l-4-4L4 16z" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" />
                        </svg>
                      </button>
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
                    aria-label={filesOn ? t.addScreenshotOrFile : t.addScreenshot}
                    title={filesOn ? t.addScreenshotOrFile : t.addScreenshot}
                    style={s.addShot}
                  >
                    <svg data-icon="photo" width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <rect x="3" y="5" width="18" height="14" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
                      <circle cx="9" cy="10" r="1.6" stroke="currentColor" strokeWidth="1.6" />
                      <path d="m4 17 5-4.5 3.5 3 2.5-2 5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
                    </svg>
                  </button>
                )}
                {files.length < lim.maxScreenshots && (
                  // Next to the screenshot tile: drag out part of the page (shipcue report 58b727d9).
                  <button
                    type="button"
                    onClick={startSelect}
                    aria-label={t.selectArea}
                    title={`${t.selectArea}${keys.selectArea?.[0] ? ` (${display(keys.selectArea[0]!)})` : ''}`}
                    style={s.addShot}
                  >
                    <svg data-icon="select-area" width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                      <path d="M12 9v6M9 12h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                    </svg>
                  </button>
                )}
              </div>
              <p style={s.hint}>
                {fill(t.attachHint, { what: `${filesOn ? 'screenshots, files' : 'screenshots'}${videoOn ? ' or a video' : ''}`, max: lim.maxScreenshots })}
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
                          {t.recordScreen}
                        </button>
                      )}
                      <button type="button" onClick={() => videoInputRef.current?.click()} style={s.linkBtn}>
                        {t.attachVideo}
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
                  {signInHref && (
                    <>
                      {' '}
                      <a href={signInHref} style={{ color: 'inherit', fontWeight: 600 }}>
                        {t.signIn}
                      </a>
                    </>
                  )}
                </p>
              )}
              {page && (
                <p style={{ ...s.hint, marginTop: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {t.page} {decodeURIComponent(new URL(page).pathname)}{' '}
                  <button type="button" onClick={() => setPage(null)} style={s.linkBtn}>
                    {t.dontAttach}
                  </button>
                </p>
              )}
              {showMine && (
                <div style={s.keysBox} aria-label={t.yourReports}>
                  {starState.mine.length === 0 ? (
                    <p style={{ ...s.hint, marginTop: 0 }}>{t.noReportsYet}</p>
                  ) : (
                    starredFirst(starState.mine, starState.stars).map((m) => (
                      <div key={m.id} style={{ ...s.keysRow, gap: 8 }}>
                        <button
                          type="button"
                          aria-label={starState.isStarred(m.id) ? `Unpin ${m.title}` : `Pin ${m.title}`}
                          aria-pressed={starState.isStarred(m.id)}
                          onClick={() => starState.toggle(m.id)}
                          style={{ ...s.linkBtn, textDecoration: 'none', color: starState.isStarred(m.id) ? '#18181b' : '#a1a1aa' }}
                        >
                          <PinIcon on={starState.isStarred(m.id)} size={12} />
                        </button>
                        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={m.title}>
                          {m.title}
                        </span>
                        <span style={{ color: '#a1a1aa', flex: 'none' }}>{new Date(m.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
                      </div>
                    ))
                  )}
                  <p style={{ ...s.hint, marginTop: 6 }}>{t.starsHint}</p>
                </div>
              )}
              {editingDisplay && (
                <div style={s.keysBox} aria-label={t.display}>
                  {([['buttonSize', t.buttonSize, buttonSizeProp], ['textSize', t.textSize, textSizeProp]] as const)
                    .filter(([k]) => k === 'textSize' || variant === 'floating')
                    .map(([k, label, fallback]) => (
                      <div key={k} style={s.keysRow}>
                        <span>{label}</span>
                        <span role="radiogroup" aria-label={label} style={{ display: 'flex', gap: 4 }}>
                          {SIZES.map((size, i) => {
                            const on = (appearance[k] ?? fallback) === size;
                            return (
                              <button
                                key={size}
                                type="button"
                                role="radio"
                                aria-checked={on}
                                aria-label={`${label}: ${size}`}
                                onClick={() => setAppearance({ ...appearance, [k]: size })}
                                style={{ ...s.keysKbd, minWidth: 24, cursor: 'pointer', ...(on ? { background: '#18181b', color: '#fff', borderColor: '#18181b' } : null) }}
                              >
                                {t.sizeNames[i]}
                              </button>
                            );
                          })}
                        </span>
                      </div>
                    ))}
                  {(canMove || canResize) && (
                    <div style={s.keysRow}>
                      <button type="button" onClick={resetPosition} style={s.linkBtn}>
                        {t.resetPosition}
                      </button>
                      {keys.resetPosition?.[0] && <kbd style={s.keysKbd}>{display(keys.resetPosition[0])}</kbd>}
                    </div>
                  )}
                  <p style={{ ...s.hint, marginTop: 6 }}>Saved in this browser.</p>
                </div>
              )}
              {editingKeys && hotkeys !== false && (
                <div style={s.keysBox} aria-label="Shortcuts">
                  {[...tabs.map((x) => ({ id: x.value as string, label: x.label })), ...(extraTabs ?? []).map((x) => ({ id: x.id, label: x.label })), ...(speech ? [{ id: 'dictate', label: t.dictate }] : []), ...(canMove || canResize ? [{ id: 'resetPosition', label: t.resetPosition }] : []), { id: 'selectArea', label: t.selectArea }].map(({ id, label }) => (
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
              {known?.signedIn && known.anonymous && (
                <label style={{ ...s.hint, display: 'flex', alignItems: 'center', gap: 6, marginTop: 10, color: '#52525b', fontSize: 11 }}>
                  <input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} />
                  {t.sendAnonymously}
                </label>
              )}
              {formExtras ? <div style={s.extras}>{formExtras}</div> : null}
              <div style={{ ...s.row, alignItems: 'center', marginTop: 12 }}>
                <span style={{ ...s.hint, marginTop: 0 }}>
                  {pastReportsHref && (
                    <a href={pastReportsHref} style={{ color: '#71717a' }}>
                      {t.pastReports}
                    </a>
                  )}
                  {pastReportsHref && ' · '}
                  <button
                    type="button"
                    onClick={() => setShowMine((v) => !v)}
                    aria-expanded={showMine}
                    style={{ ...s.linkBtn, fontSize: 10, textDecoration: 'none', color: '#71717a' }}
                  >
                    {t.yours}
                    {starState.mine.length > 0 ? ` (${starState.mine.length})` : ''}
                  </button>
                  {' · '}
                  <button
                    type="button"
                    onClick={() => setEditingDisplay((v) => !v)}
                    aria-expanded={editingDisplay}
                    style={{ ...s.linkBtn, fontSize: 10, textDecoration: 'none', color: '#71717a' }}
                  >
                    {t.display}
                  </button>
                  {(hotkeys !== false || onEditShortcuts) && ' · '}
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
                      {t.shortcuts}
                    </button>
                  )}
                  {canCopyPrompt && ' · '}
                  {canCopyPrompt && (
                    <button
                      type="button"
                      onClick={() => void copyAgentPrompt()}
                      title={t.copyAgentPromptHint}
                      style={{ ...s.linkBtn, fontSize: 10, textDecoration: 'none', color: promptCopied ? '#18181b' : '#71717a' }}
                    >
                      {promptCopied ? t.copied : t.copyAgentPrompt}
                    </button>
                  )}
                </span>
                <button type="button" onClick={send} disabled={!canSend} style={canSend ? s.send : { ...s.send, opacity: 0.5, cursor: 'not-allowed' }}>
                  {/* Both labels share one grid cell, the other one invisible, so the button keeps the width
                      of the longer one and never wraps or grows while sending (shipcue report 81ff37de). */}
                  <span style={s.sendLabels}>
                    <span style={busy ? s.sendLabelHidden : s.sendLabel} aria-hidden={busy || undefined}>
                      {t.send}
                    </span>
                    <span style={busy ? s.sendLabel : s.sendLabelHidden} aria-hidden={!busy || undefined}>
                      {t.sending}
                    </span>
                  </span>
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
        </ResizeBox>
      )}

      {sent && (
        <div role="status" style={s.sent}>
          {successMessage ?? t.sent}
          {pastReportsHref && (
            <>
              {' '}
              <a href={pastReportsHref} style={{ color: 'inherit', fontWeight: 600 }}>
                {t.seeReports}
              </a>
            </>
          )}
          {sent.warning && <p style={{ margin: '4px 0 0', color: '#be123c' }}>{t.videoNotAttached} {sent.warning}</p>}
        </div>
      )}
      {recording !== null && (
        <button type="button" onClick={() => recorderRef.current?.stop()} aria-label={t.stopRecording} title={t.stopRecording} style={s.recording}>
          ● {Math.floor(recording / 60)}:{String(recording % 60).padStart(2, '0')}
        </button>
      )}
      {lightbox.box}
      {trigger !== false && (
        <button
          type="button"
          onClick={() => {
            // The end of a drag is not a click.
            if (drag.justDragged()) return;
            open ? close() : openOn();
          }}
          {...drag.handlers}
          aria-label={open ? t.closeButton : t.openButton}
          title={t.openButton}
          style={variant === 'floating' ? { ...s.fab, width: buttonPx, height: buttonPx, ...(drag.dragging ? { cursor: 'grabbing' } : null) } : s.inlineBtn}
        >
          {launcherIcon ?? (icon === 'hat' ? (
            <HatIcon size={variant === 'floating' ? Math.round(buttonPx / 2) : 19} />
          ) : (
          <svg data-icon="ship" width={variant === 'floating' ? Math.round(buttonPx * 0.46) : 18} height={variant === 'floating' ? Math.round(buttonPx * 0.46) : 18} viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 3v12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            <path d="M12 4.5 18 13h-6z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
            <path d="M12 7.5 7 13h5" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
            <path d="M3 15.5h18l-2.2 3.9a2 2 0 0 1-1.74 1.1H6.94a2 2 0 0 1-1.74-1.1z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
          </svg>
          ))}
        </button>
      )}
    </div>
  );
}

// Inline styles so the button works in any app with no CSS setup.
/**
 * shipcue's mark: a builder's hard hat, side on, with its headlamp (shipcue report 9806af04).
 * Solid in currentColor; the lamp is cut out so the button's colour shows through.
 */
export function HatIcon({ size = 24 }: { size?: number }) {
  // Lucide's hard-hat (ISC, lucide.dev): crisp strokes at every size (shipcue report 7f2dac1e).
  return (
    <svg data-icon="hat" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 10V5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v5" />
      <path d="M14 6a6 6 0 0 1 6 6v3" />
      <path d="M4 15v-3a6 6 0 0 1 6-6" />
      <rect x="2" y="15" width="20" height="4" rx="1" />
    </svg>
  );
}

/** The bit of the Web Speech API the panel uses (SpeechRecognition / webkitSpeechRecognition). */
interface SpeechLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

const POSITION_KEY = 'shipcue:button-position';
const EDGE = 8;

/** 0.17's separate spot for the panel; the panel now moves with the button (shipcue report 30beb674). */
const OLD_PANEL_OFFSET_KEY = 'shipcue:panel-offset';
const NOT_A_HANDLE = 'button, a, input, select, textarea, label, [role="radio"], [contenteditable="true"]';

/**
 * Drag the floating widget anywhere (shipcue report 9061b5f6): by the button, or by the panel's
 * title (report 76015f97), which moves the button and the panel together (report 30beb674). There
 * is one spot, the button's centre; the wrapper is anchored to the nearest corner, so the panel
 * opens towards the middle of the screen and never off it. A title drag only translates the
 * widget (held on screen); the new spot, and any flip of the panel above or below the button,
 * comes on release.
 */
function useDraggableWidget(enabled: boolean, FAB: number, wrapRef: React.RefObject<HTMLDivElement | null>) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ px: number; py: number; moved: boolean } | null>(null);
  const dragged = useRef(false);
  const [, setViewport] = useState(0);
  // A title drag in progress: where it started, the button's centre then, and how far the
  // widget may go each way before it would leave the screen.
  const [shift, setShift] = useState<{ x: number; y: number } | null>(null);
  const titleStart = useRef<{ px: number; py: number; cx: number; cy: number; minX: number; maxX: number; minY: number; maxY: number } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    try {
      localStorage.removeItem(OLD_PANEL_OFFSET_KEY);
      const saved = JSON.parse(localStorage.getItem(POSITION_KEY) ?? 'null') as { x?: unknown; y?: unknown } | null;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is only there in the browser
      if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') setPos({ x: saved.x, y: saved.y });
    } catch {
      // Storage blocked: bottom-right.
    }
    const onResize = () => setViewport((n) => n + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [enabled]);

  const clamp = (x: number, y: number) => {
    const half = FAB / 2 + EDGE;
    return {
      x: Math.min(Math.max(x, half), Math.max(half, window.innerWidth - half)),
      y: Math.min(Math.max(y, half), Math.max(half, window.innerHeight - half)),
    };
  };
  const save = (next: { x: number; y: number }) => {
    setPos(next);
    try {
      localStorage.setItem(POSITION_KEY, JSON.stringify(next));
    } catch {
      // Storage blocked: the spot lasts until the page reloads.
    }
  };

  let wrapStyle: CSSProperties = {};
  if (enabled && pos && typeof window !== 'undefined') {
    const { x, y } = clamp(pos.x, pos.y);
    const right = x > window.innerWidth / 2;
    const bottom = y > window.innerHeight / 2;
    wrapStyle = {
      ...(right ? { right: window.innerWidth - x - FAB / 2, left: 'auto', alignItems: 'flex-end' } : { left: x - FAB / 2, right: 'auto', alignItems: 'flex-start' }),
      ...(bottom ? { bottom: window.innerHeight - y - FAB / 2, top: 'auto', flexDirection: 'column' } : { top: y - FAB / 2, bottom: 'auto', flexDirection: 'column-reverse' }),
    };
  }
  if (shift) wrapStyle = { ...wrapStyle, transform: `translate(${shift.x}px, ${shift.y}px)` };

  const handlers = enabled
    ? {
        onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
          if (e.button !== 0) return;
          start.current = { px: e.clientX, py: e.clientY, moved: false };
          // Captured from the press, so a quick drag that leaves the 48px button still moves it.
          try {
            e.currentTarget.setPointerCapture?.(e.pointerId);
          } catch {
            // An unknown pointer (some synthetic events).
          }
        },
        onPointerMove: (e: React.PointerEvent<HTMLButtonElement>) => {
          const st = start.current;
          if (!st) return;
          if (!st.moved && Math.hypot(e.clientX - st.px, e.clientY - st.py) < 5) return;
          if (!st.moved) {
            st.moved = true;
            setDragging(true);
          }
          setPos(clamp(e.clientX, e.clientY));
        },
        onPointerUp: (e: React.PointerEvent<HTMLButtonElement>) => {
          const st = start.current;
          start.current = null;
          if (!st?.moved) return;
          dragged.current = true;
          setDragging(false);
          save(clamp(e.clientX, e.clientY));
        },
      }
    : {};

  /** How far the title drag has gone, held so the whole widget stays on screen. */
  const titleShift = (st: NonNullable<typeof titleStart.current>, e: React.PointerEvent) => ({
    x: Math.min(Math.max(e.clientX - st.px, st.minX), st.maxX),
    y: Math.min(Math.max(e.clientY - st.py, st.minY), st.maxY),
  });
  const panelHandlers = enabled
    ? {
        onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
          const wrap = wrapRef.current;
          if (e.button !== 0 || !wrap || (e.target as Element).closest(NOT_A_HANDLE)) return;
          const r = wrap.getBoundingClientRect();
          // Unmoved, the widget sits in its bottom-right corner, with the button there.
          const c = pos ? clamp(pos.x, pos.y) : { x: r.right - FAB / 2, y: r.bottom - FAB / 2 };
          titleStart.current = {
            px: e.clientX,
            py: e.clientY,
            cx: c.x,
            cy: c.y,
            // Never pushed further off an edge it already overhangs.
            minX: Math.min(0, EDGE - r.left),
            maxX: Math.max(0, window.innerWidth - EDGE - r.right),
            minY: Math.min(0, EDGE - r.top),
            maxY: Math.max(0, window.innerHeight - EDGE - r.bottom),
          };
          setDragging(true);
          try {
            e.currentTarget.setPointerCapture?.(e.pointerId);
          } catch {
            // An unknown pointer (some synthetic events).
          }
        },
        onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
          const st = titleStart.current;
          if (st) setShift(titleShift(st, e));
        },
        onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => {
          const st = titleStart.current;
          titleStart.current = null;
          setDragging(false);
          setShift(null);
          if (!st) return;
          const d = titleShift(st, e);
          if (d.x || d.y) save(clamp(st.cx + d.x, st.cy + d.y));
        },
        onPointerCancel: () => {
          titleStart.current = null;
          setDragging(false);
          setShift(null);
        },
      }
    : {};

  // The button's quadrant: bottom-right until it is moved (the panel opens away from it).
  const corner = enabled && pos && typeof window !== 'undefined'
    ? (({ x, y }) => ({ right: x > window.innerWidth / 2, bottom: y > window.innerHeight / 2 }))(clamp(pos.x, pos.y))
    : { right: true, bottom: true };

  return {
    wrapStyle,
    corner,
    handlers,
    panelHandlers,
    dragging,
    /** The panel title's grab cursor. */
    handleStyle: (enabled ? { cursor: dragging ? 'grabbing' : 'grab', touchAction: 'none', userSelect: 'none' } : {}) as CSSProperties,
    /** Back to the corner it started in, and forget the saved spot. */
    reset: () => {
      setPos(null);
      setShift(null);
      try {
        localStorage.removeItem(POSITION_KEY);
      } catch {
        // Storage blocked: nothing was saved.
      }
    },
    /** True once, right after a drag ended, so that release is not taken as a click. */
    justDragged: () => {
      const was = dragged.current;
      dragged.current = false;
      return was;
    },
  };
}

/** The floating panel's default width; resizing never goes narrower. */
const PANEL_WIDTH = 'min(92vw, 24rem)';
/** The floating panel never grows past this, resized or not. */
const PANEL_MAX_HEIGHT = 'calc(100dvh - 6rem)';

/** The panel and its resize grip, laid over the free corner; just the panel when off. */
function ResizeBox({ on, grip, children }: { on: boolean; grip: React.ReactNode; children: React.ReactNode }) {
  return on ? (
    <div style={{ position: 'relative' }}>
      {children}
      {grip}
    </div>
  ) : (
    <>{children}</>
  );
}

/**
 * Resize the floating panel by its free corner (shipcue report ee970b18): the one away from the
 * button, so it grows towards the middle of the screen while the button stays put. Sizes are CSS
 * px before the textSize zoom, at least the panel's own default and at most what keeps it 8px
 * inside the window; kept in this browser. Arrow keys on the focused grip resize it too.
 */
function usePanelResize(enabled: boolean, panelRef: React.RefObject<HTMLDivElement | null>, zoom: number) {
  const [size, setSize] = useState<PanelSize | null>(null);
  const [, setViewport] = useState(0);
  const start = useRef<{ px: number; py: number; w: number; h: number; left: boolean; top: boolean; b: Bounds } | null>(null);
  const [touch, setTouch] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is only there in the browser
    setSize(loadPanelSize());
    setTouch(typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches);
    const onResize = () => setViewport((n) => n + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [enabled]);

  type Bounds = { minW: number; maxW: number; minH: number; maxH: number };
  /** The panel's size now, and how small and big it may get, in CSS px. */
  const measure = (left: boolean, top: boolean) => {
    const el = panelRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    // Its default size: the same panel without the chosen width and height.
    const { width, minHeight } = el.style;
    el.style.width = PANEL_WIDTH;
    el.style.minHeight = '';
    const d = el.getBoundingClientRect();
    el.style.width = width;
    el.style.minHeight = minHeight;
    const minW = d.width / zoom;
    const minH = d.height / zoom;
    const b: Bounds = {
      minW,
      minH,
      maxW: Math.max(minW, (left ? r.right - EDGE : window.innerWidth - EDGE - r.left) / zoom),
      maxH: Math.max(minH, (top ? r.bottom - EDGE : window.innerHeight - EDGE - r.top) / zoom),
    };
    return { w: r.width / zoom, h: r.height / zoom, b };
  };
  const fit = (w: number, h: number, b: Bounds): PanelSize => ({
    width: Math.round(Math.min(Math.max(w, b.minW), b.maxW)),
    height: Math.round(Math.min(Math.max(h, b.minH), b.maxH)),
  });

  const panelStyle: CSSProperties =
    enabled && size && typeof window !== 'undefined'
      ? {
          // Never wider than the window, even after it shrank.
          width: Math.min(size.width, (window.innerWidth - 2 * EDGE) / zoom),
          minHeight: `min(${size.height}px, ${PANEL_MAX_HEIGHT})`,
          display: 'flex',
          flexDirection: 'column',
        }
      : {};

  /** The grip on the corner away from the button (`corner`: the button's quadrant). */
  const grip = (corner: { right: boolean; bottom: boolean }, label: string) => {
    if (!enabled) return null;
    const left = corner.right;
    const top = corner.bottom;
    const hit = touch ? RESIZE.gripTouch : RESIZE.grip;
    // The glyph is drawn for the bottom-right corner and turned to face this one.
    const turn = top ? (left ? 'rotate(180deg)' : 'scaleY(-1)') : left ? 'scaleX(-1)' : '';
    return (
      <button
        type="button"
        aria-label={label}
        title={label}
        data-shipcue-resize=""
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          const m = measure(left, top);
          if (!m) return;
          start.current = { px: e.clientX, py: e.clientY, w: m.w, h: m.h, left, top, b: m.b };
          try {
            e.currentTarget.setPointerCapture?.(e.pointerId);
          } catch {
            // An unknown pointer (some synthetic events).
          }
        }}
        onPointerMove={(e) => {
          const st = start.current;
          if (!st) return;
          const dx = (e.clientX - st.px) / zoom;
          const dy = (e.clientY - st.py) / zoom;
          setSize(fit(st.w + (st.left ? -dx : dx), st.h + (st.top ? -dy : dy), st.b));
        }}
        onPointerUp={(e) => {
          const st = start.current;
          start.current = null;
          if (!st) return;
          const dx = (e.clientX - st.px) / zoom;
          const dy = (e.clientY - st.py) / zoom;
          const next = fit(st.w + (st.left ? -dx : dx), st.h + (st.top ? -dy : dy), st.b);
          setSize(next);
          savePanelSize(next);
        }}
        onPointerCancel={() => {
          start.current = null;
        }}
        onKeyDown={(e) => {
          // The arrows move the corner: towards the middle of the screen grows the panel.
          const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
          if (!d) return;
          e.preventDefault();
          e.stopPropagation();
          const m = measure(left, top);
          if (!m) return;
          const step = e.shiftKey ? RESIZE.bigStep : RESIZE.step;
          const next = fit(m.w + d[0]! * step * (left ? -1 : 1), m.h + d[1]! * step * (top ? -1 : 1), m.b);
          setSize(next);
          savePanelSize(next);
        }}
        style={{
          position: 'absolute',
          [top ? 'top' : 'bottom']: 0,
          [left ? 'left' : 'right']: 0,
          width: hit,
          height: hit,
          padding: 0,
          border: 0,
          borderRadius: 4,
          background: 'transparent',
          color: '#a1a1aa',
          opacity: 0.7,
          display: 'flex',
          alignItems: top ? 'flex-start' : 'flex-end',
          justifyContent: left ? 'flex-start' : 'flex-end',
          cursor: left === top ? 'nwse-resize' : 'nesw-resize',
          touchAction: 'none',
        }}
      >
        <svg data-icon="resize" width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true" style={{ margin: 4, transform: turn }}>
          <path d="M9 3 3 9M9 6.5 6.5 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      </button>
    );
  };

  return {
    size: enabled ? size : null,
    panelStyle,
    grip,
    /** Back to the default size, and forget the saved one. */
    reset: () => {
      setSize(null);
      start.current = null;
      savePanelSize(null);
    },
  };
}

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
    panel: { ...card, width: PANEL_WIDTH, maxHeight: PANEL_MAX_HEIGHT } as CSSProperties,
    /** A resized panel's form: a column whose text box takes the extra height (report ee970b18). */
    grow: { flex: '1 0 auto', display: 'flex', flexDirection: 'column' } as CSSProperties,
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
    dim: { position: 'fixed', inset: 0, zIndex: 2147482999, background: 'rgba(9,9,11,0.35)', pointerEvents: 'none' } as CSSProperties,
    edit: {
      position: 'absolute',
      bottom: -6,
      right: -6,
      width: 20,
      height: 20,
      borderRadius: 999,
      border: '1px solid #e4e4e7',
      background: '#fff',
      color: '#3f3f46',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 0,
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
    contextPreview: { marginTop: 4, maxHeight: 160, overflowY: 'auto', padding: '6px 10px', border: '1px solid #e4e4e7', borderRadius: 8, background: '#fafafa', fontSize: 12, lineHeight: 1.45, color: '#27272a', fontFamily: font } as CSSProperties,
    keysBox: { marginTop: 10, padding: '8px 10px', border: '1px solid #e4e4e7', borderRadius: 8, fontSize: 11, color: '#3f3f46', fontFamily: font } as CSSProperties,
    keysRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '3px 0' } as CSSProperties,
    keysKbd: { minWidth: 44, textAlign: 'center', padding: '1px 6px', border: '1px solid #e4e4e7', borderRadius: 4, background: '#fafafa', fontSize: 10, fontFamily: 'inherit' } as CSSProperties,
    linkBtn: { border: 0, background: 'transparent', color: '#71717a', padding: 0, fontSize: 11, textDecoration: 'underline', cursor: 'pointer' } as CSSProperties,
    recording: { border: 0, borderRadius: 999, background: '#e11d48', color: '#fff', padding: '8px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' } as CSSProperties,
    extras: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#71717a', margin: '6px 0 0' } as CSSProperties,
    send: { display: 'inline-flex', alignItems: 'center', flex: 'none', whiteSpace: 'nowrap', border: 0, borderRadius: 8, background: accent, color: '#fff', padding: '6px 12px', fontSize: 14, fontWeight: 500, fontFamily: font, cursor: 'pointer' } as CSSProperties,
    sendLabels: { display: 'inline-grid' } as CSSProperties,
    sendLabel: { gridArea: '1 / 1' } as CSSProperties,
    sendLabelHidden: { gridArea: '1 / 1', visibility: 'hidden' } as CSSProperties,
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
      touchAction: 'none',
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
