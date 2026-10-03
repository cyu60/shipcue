import { useEffect, useState, type CSSProperties } from 'react';
import { shotAlt, type Board, type BoardItem, type ReportType } from '../core';
import { fill, resolveText, type ShipcueText } from './text';
import { useLightbox } from './Lightbox';
import { PinIcon } from './PinIcon';
import { fixLabel } from './fixLink';
import { starredFirst, useStars } from './stars';

type View = 'open' | 'fixed' | 'all' | 'changelog' | 'starred';
export type BoardTabStyle = 'pills' | 'tabs';
export type BoardLayout = 'cards' | 'list';

const VIEW_KEY = 'shipcue:board-view';
function loadView(): { tabStyle?: BoardTabStyle; layout?: BoardLayout } {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) ?? '{}') as Record<string, unknown>;
    return {
      ...(v.tabStyle === 'pills' || v.tabStyle === 'tabs' ? { tabStyle: v.tabStyle } : {}),
      ...(v.layout === 'cards' || v.layout === 'list' ? { layout: v.layout } : {}),
    };
  } catch {
    return {};
  }
}

export interface ShipcueBoardProps {
  /** Where the handler is mounted, e.g. "/api/shipcue" (it must be created with `board`). */
  endpoint?: string;
  /** Which lists to show. Both by default, as Open / Fixed / All / Changelog pills. */
  show?: 'both' | 'queue' | 'changelog';
  /** With show="both", the tab it starts on. 'queue' is the same as 'open'. */
  initialView?: View | 'queue';
  /** Pills (default) or an underlined tab row; each viewer can switch, kept in their browser. */
  tabStyle?: BoardTabStyle;
  /** Cards (default) or a compact one-line list; each viewer can switch too. */
  layout?: BoardLayout;
  /** The small View control that lets each viewer pick. On by default. */
  viewPicker?: boolean;
  /** A search box, and a type picker when the board has more than one type. Off by default. */
  filters?: boolean;
  /** Keep the tab in the page's URL (?view=changelog), so it can be linked. Off by default: it writes to your URL. */
  syncUrl?: boolean;
  /** Your own words for the tabs, empty states and labels; see DEFAULT_TEXT. */
  text?: Partial<ShipcueText>;
  /** Heading color and the small accents. */
  accentColor?: string;
  /** Re-read the board this often while the page is open (ms). 0 turns it off. */
  refreshMs?: number;
  /**
   * Live: check {endpoint}/board/version this often while the page is in view (ms), and re-read
   * the board as soon as a report is filed or changes. 5 s by default; 0 turns it off.
   */
  liveMs?: number;
  className?: string;
  style?: CSSProperties;
}

/**
 * The public side of the queue: what is waiting or being worked on, and a
 * changelog of what was fixed and how. Reads GET {endpoint}/board.
 */
export function ShipcueBoard({
  endpoint = '/api/shipcue',
  show = 'both',
  initialView = 'open',
  tabStyle: tabStyleProp = 'pills',
  layout: layoutProp = 'cards',
  viewPicker = true,
  filters = false,
  syncUrl = false,
  text: textProp,
  accentColor = '#16203A',
  refreshMs = 60_000,
  liveMs = 5_000,
  className,
  style,
}: ShipcueBoardProps) {
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const t = resolveText(textProp);
  const st = useStars();
  const lb = useLightbox();
  const startView: View = initialView === 'queue' ? 'open' : initialView;
  const urlOn = syncUrl && show === 'both';
  const [view, setViewState] = useState<View>(() => (urlOn ? (readView() ?? startView) : startView));
  // The tab goes in the URL, so /cuelog/?view=changelog can be linked (Habitect's /reports?tab=).
  const setView = (next: View) => {
    setViewState(next);
    if (urlOn) writeView(next === startView ? null : next);
  };
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<ReportType | ''>('');
  // Each viewer's own pick (shipcue report bf463120), over the app's default.
  const [picked, setPicked] = useState<{ tabStyle?: BoardTabStyle; layout?: BoardLayout }>({});
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is only there in the browser
    if (viewPicker) setPicked(loadView());
  }, [viewPicker]);
  const tabStyle = picked.tabStyle ?? tabStyleProp;
  const layout = picked.layout ?? layoutProp;
  const pick = (next: { tabStyle?: BoardTabStyle; layout?: BoardLayout }) => {
    const merged = { ...picked, ...next };
    setPicked(merged);
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify(merged));
    } catch {
      // Storage blocked: the pick lasts until the page reloads.
    }
  };

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const res = await fetch(`${endpoint.replace(/\/$/, '')}/board`, { cache: 'no-store' });
        if (!res.ok) throw new Error(res.status === 404 ? 'The board is not switched on.' : 'Could not load the board.');
        const next = (await res.json()) as Board;
        if (live) {
          setBoard(next);
          setError(null);
        }
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : 'Could not load the board.');
      }
    };
    void load();
    const timer = refreshMs > 0 ? setInterval(load, refreshMs) : undefined;
    // Live updates (shipcue report c83b6f71): a tiny version check, the full board only when it moved.
    let seen: string | null = null;
    let liveOn = liveMs > 0;
    const check = async () => {
      if (!liveOn || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return;
      try {
        const res = await fetch(`${endpoint.replace(/\/$/, '')}/board/version`, { cache: 'no-store' });
        if (res.status === 404) {
          liveOn = false; // An older handler: the slow refresh still runs.
          return;
        }
        if (!res.ok) return;
        const { version } = (await res.json()) as { version?: string };
        if (!version) return;
        if (seen !== null && version !== seen) await load();
        seen = version;
      } catch {
        // Offline for a moment: the next check tries again.
      }
    };
    const liveTimer = liveOn ? setInterval(check, liveMs) : undefined;
    const onVisible = () => void check();
    if (liveOn) {
      void check();
      document.addEventListener('visibilitychange', onVisible);
    }
    return () => {
      live = false;
      if (timer) clearInterval(timer);
      if (liveTimer) clearInterval(liveTimer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [endpoint, refreshMs, liveMs]);

  if (error && !board) return <p className={className} style={{ ...s.muted, ...style }}>{error}</p>;
  if (!board) return <p className={className} style={{ ...s.muted, ...style }}>{t.loading}</p>;

  // Search and type narrow every list, and the counts follow (shipcue report 5c54da74).
  const types = [...new Set([...board.queue, ...board.changelog].map((r) => r.type))];
  const q = query.trim().toLowerCase();
  const keep = (r: BoardItem) =>
    (!typeFilter || r.type === typeFilter) && (!q || `${r.description} ${r.resolution ?? ''} ${r.area}`.toLowerCase().includes(q));
  const narrowed = q || typeFilter ? { queue: board.queue.filter(keep), changelog: board.changelog.filter(keep) } : board;
  return <BoardBody {...{ board: narrowed, types, query, setQuery, typeFilter, setTypeFilter, filters, view, setView, show, tabStyle, layout, viewPicker, pick, t, st, lb, accentColor, className, style }} />;
}

interface BodyProps {
  board: Board;
  types: ReportType[];
  query: string;
  setQuery: (q: string) => void;
  typeFilter: ReportType | '';
  setTypeFilter: (t: ReportType | '') => void;
  filters: boolean;
  view: View;
  setView: (v: View) => void;
  show: 'both' | 'queue' | 'changelog';
  tabStyle: BoardTabStyle;
  layout: BoardLayout;
  viewPicker: boolean;
  pick: (next: { tabStyle?: BoardTabStyle; layout?: BoardLayout }) => void;
  t: ShipcueText;
  st: ReturnType<typeof useStars>;
  lb: ReturnType<typeof useLightbox>;
  accentColor: string;
  className?: string;
  style?: CSSProperties;
}

function BoardBody({ board, types, query, setQuery, typeFilter, setTypeFilter, filters, view, setView, show, tabStyle, layout, viewPicker, pick, t, st, lb, accentColor, className, style }: BodyProps) {
  // With both lists, pill tabs: Open, Fixed, All, Changelog, with counts
  // (shipcue reports 9fdd0b45, 15720123).
  const TABS: { id: View; label: string; count?: number }[] = [
    { id: 'open', label: t.open, count: board.queue.length },
    { id: 'fixed', label: t.fixed, count: board.changelog.length },
    { id: 'all', label: t.all, count: board.queue.length + board.changelog.length },
    { id: 'changelog', label: t.changelog },
  ];
  // Stars pin reports to the top (shipcue report 013562b6); a Starred tab once there are some.
  const starredItems = [...board.queue, ...board.changelog].filter((r) => st.isStarred(r.id));
  if (starredItems.length > 0 || view === 'starred') TABS.push({ id: 'starred', label: t.starred, count: starredItems.length });
  const itemProps = (r: BoardItem) => ({
    star: { on: st.isStarred(r.id), mine: st.isMine(r.id), toggle: () => st.toggle(r.id) },
    onShot: (i: number) => lb.open(r.screenshots ?? [], i),
  });
  const current: View | 'queue' = show === 'both' ? view : show;
  const list = (items: BoardItem[], done = false) => (
    <ul style={layout === 'list' ? s.listCompact : s.list}>
      {starredFirst(items, st.stars).map((r) => (
        <Item key={r.id} r={r} t={t} accent={accentColor} done={done || r.status === 'fixed'} compact={layout === 'list'} {...itemProps(r)} />
      ))}
    </ul>
  );
  return (
    <div className={className} style={{ ...s.wrap, ...style }}>
      {(show === 'both' || viewPicker || filters) && (
        <div style={tabStyle === 'tabs' ? { ...s.bar, ...s.barTabs } : s.bar}>
      {show === 'both' ? (
        <div role="tablist" aria-label="Reports" style={tabStyle === 'tabs' ? s.underTabs : s.tabs}>
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={view === t.id}
              aria-label={t.count !== undefined ? `${t.label} ${t.count}` : t.label}
              onClick={() => setView(t.id)}
              style={
                tabStyle === 'tabs'
                  ? view === t.id
                    ? { ...s.underTab, ...s.underTabOn, borderBottomColor: accentColor, color: accentColor }
                    : s.underTab
                  : view === t.id
                    ? { ...s.tab, background: accentColor, color: '#fff' }
                    : s.tab
              }
            >
              {t.label}
              {t.count !== undefined && <span style={s.count}>{t.count}</span>}
            </button>
          ))}
        </div>
      ) : (
        <span />
      )}
      {filters && (
        <span style={s.filters}>
          <input type="search" aria-label={t.search} placeholder={t.search} value={query} onChange={(e) => setQuery(e.target.value)} style={s.search} />
          {types.length > 1 && (
            <select aria-label="Type" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as ReportType | '')} style={s.search}>
              <option value="">{t.allTypes}</option>
              {types.map((k) => (
                <option key={k} value={k}>
                  {typeLabel(t, k)}
                </option>
              ))}
            </select>
          )}
        </span>
      )}
      {viewPicker && (
        <span style={s.picker} aria-label="View">
          <Toggle label="Tab style" value={tabStyle} options={[['pills', t.pills], ['tabs', t.tabs]]} onPick={(v) => pick({ tabStyle: v })} />
          <span aria-hidden="true"> · </span>
          <Toggle label="Layout" value={layout} options={[['cards', t.cards], ['list', t.list]]} onPick={(v) => pick({ layout: v })} />
        </span>
      )}
        </div>
      )}
      {current === 'open' && (
        <section>
          {board.queue.length === 0 ? <p style={s.muted}>{t.nothingWaiting}</p> : list(board.queue)}
        </section>
      )}
      {current === 'fixed' && (
        <section>{board.changelog.length === 0 ? <p style={s.muted}>{t.nothingFixed}</p> : list(board.changelog, true)}</section>
      )}
      {current === 'all' && (
        <section>
          {list(board.queue)}
          {board.changelog.length > 0 && <div style={{ marginTop: '0.75em' }}>{list(board.changelog, true)}</div>}
        </section>
      )}
      {current === 'queue' && (
        <section>
          <h2 style={{ ...s.h2, color: accentColor }}>{t.queueTitle}</h2>
          <p style={s.muted}>
            {board.queue.length === 0 ? t.nothingWaiting : fill(t.queueSummary, { n: board.queue.length })}
            {board.changelog.length > 0 ? ` ${t.doneBelow}` : ''}
          </p>
          <ul style={layout === 'list' ? s.listCompact : s.list}>
            {starredFirst(board.queue, st.stars).map((r) => (
              <Item key={r.id} r={r} t={t} accent={accentColor} compact={layout === 'list'} {...itemProps(r)} />
            ))}
            {/* Finished ones stay in the queue, greyed out, so nothing seems to vanish. */}
            {board.changelog.map((r) => (
              <Item key={r.id} r={r} t={t} accent={accentColor} done compact={layout === 'list'} {...itemProps(r)} />
            ))}
          </ul>
        </section>
      )}
      {current === 'starred' && <section>{starredItems.length === 0 ? <p style={s.muted}>{t.starsHint}</p> : list(starredItems)}</section>}
      {current === 'changelog' && (
        <section>
          {show !== 'both' && <h2 style={{ ...s.h2, color: accentColor }}>{t.changelog}</h2>}
          <p style={s.muted}>{board.changelog.length === 0 ? t.nothingShipped : t.latestFirst}</p>
          {/* Pinned first, then a heading per day it shipped, as Habitect's changelog groups them. */}
          {byDay(board.changelog, st.stars, t.pinnedHeading).map((g) => (
            <div key={g.label} style={s.day}>
              <h3 style={s.dayHead}>{g.label}</h3>
              <ul style={layout === 'list' ? s.listCompact : s.list}>
                {g.items.map((r) => (
                  <Item key={r.id} r={r} t={t} accent={accentColor} changelog compact={layout === 'list'} {...itemProps(r)} />
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}
      {lb.box}
    </div>
  );
}

/** Just the queue. */
export const ShipcueQueue = (props: Omit<ShipcueBoardProps, 'show'>) => <ShipcueBoard {...props} show="queue" />;
/** Just the changelog. */
export const ShipcueChangelog = (props: Omit<ShipcueBoardProps, 'show'>) => <ShipcueBoard {...props} show="changelog" />;

const VIEWS: readonly View[] = ['open', 'fixed', 'all', 'changelog', 'starred'];
function readView(): View | undefined {
  if (typeof window === 'undefined') return undefined;
  const v = new URL(window.location.href).searchParams.get('view');
  return VIEWS.find((x) => x === v);
}
function writeView(v: View | null) {
  try {
    const url = new URL(window.location.href);
    if (v) url.searchParams.set('view', v);
    else url.searchParams.delete('view');
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, '', url);
  } catch {
    // No URL to update: the tab still switches.
  }
}

/** The changelog in groups: pinned ones first, then one per day, latest first. */
export function byDay<T extends BoardItem>(items: readonly T[], pins: readonly string[], pinnedLabel: string): { label: string; items: T[] }[] {
  const pinned = items.filter((r) => pins.includes(r.id));
  const groups: { label: string; items: T[] }[] = pinned.length ? [{ label: pinnedLabel, items: pinned }] : [];
  for (const r of items) {
    if (pins.includes(r.id)) continue;
    const label = day(r.updatedAt);
    const last = groups[groups.length - 1];
    if (last && last.label === label && last.label !== pinnedLabel) last.items.push(r);
    else groups.push({ label, items: [r] });
  }
  return groups;
}

function day(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Two small text options, the chosen one darker, for the View control. */
function Toggle<T extends string>({ label, value, options, onPick }: { label: string; value: T; options: [T, string][]; onPick: (v: T) => void }) {
  return (
    <span role="radiogroup" aria-label={label}>
      {options.map(([v, text], i) => (
        <span key={v}>
          {i > 0 && <span aria-hidden="true">/</span>}
          <button type="button" role="radio" aria-checked={value === v} onClick={() => onPick(v)} style={value === v ? { ...s.pickBtn, ...s.pickOn } : s.pickBtn}>
            {text}
          </button>
        </span>
      ))}
    </span>
  );
}

const typeLabel = (t: ShipcueText, type: ReportType) => (type === 'bug' ? t.bugTab : type === 'feature' ? t.featureTab : t.taskTab);

interface ItemStar {
  on: boolean;
  mine: boolean;
  toggle: () => void;
}

function StarButton({ star, label }: { star: ItemStar; label: string }) {
  return (
    <button
      type="button"
      aria-label={star.on ? `Unpin: ${label}` : `Pin: ${label}`}
      aria-pressed={star.on}
      title={star.on ? 'Unpin' : 'Pin it to the top'}
      onClick={star.toggle}
      style={{ ...s.pickBtn, opacity: star.on ? 1 : 0.55, padding: 0, color: 'inherit', lineHeight: 1, flex: 'none' }}
    >
      <PinIcon on={star.on} size={13} />
    </button>
  );
}

/** "PR #12 ↗" (or "commit ↗"), out to the fix on GitHub. */
function FixLink({ url, t }: { url: string; t: ShipcueText }) {
  const label = fixLabel(url);
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" title={t.seeTheFix} aria-label={`${t.seeTheFix}: ${label}`} style={{ ...s.tag, color: 'inherit', textDecoration: 'none', flex: 'none' }}>
      {label} ↗
    </a>
  );
}

function Item({
  r,
  t,
  accent,
  changelog = false,
  done = false,
  compact = false,
  star,
  onShot,
}: {
  r: BoardItem;
  t: ShipcueText;
  accent: string;
  changelog?: boolean;
  done?: boolean;
  compact?: boolean;
  star?: ItemStar;
  onShot?: (index: number) => void;
}) {
  if (compact) {
    // One line: type, the fix (or the ask), date. No screenshots.
    const text = changelog && r.resolution ? r.resolution : r.description;
    return (
      <li style={done ? { ...s.row, ...s.done } : s.row}>
        {star && <StarButton star={star} label={text.slice(0, 60)} />}
        <span style={{ ...s.tag, borderColor: accent, color: accent, flex: 'none' }}>{typeLabel(t, r.type)}</span>
        {star?.mine && <span style={{ ...s.tag, flex: 'none' }}>{t.yours}</span>}
        <span style={s.rowText} title={text}>
          {text}
        </span>
        {r.prUrl && <FixLink url={r.prUrl} t={t} />}
        <span style={s.rowDate}>{day(changelog ? r.updatedAt : r.createdAt)}</span>
      </li>
    );
  }
  return (
    <li style={done ? { ...s.item, ...s.done } : s.item}>
      <div style={s.meta}>
        {star && <StarButton star={star} label={r.description.slice(0, 60)} />}
        <span style={{ ...s.tag, borderColor: accent, color: accent }}>{typeLabel(t, r.type)}</span>
        {star?.mine && <span style={s.tag}>{t.yours}</span>}
        {done && <span style={s.tag}>{t.done}</span>}
        {!changelog && r.status === 'claimed' && <span style={s.tag}>{t.inProgress}</span>}
        {!changelog && r.status === 'in_review' && <span style={s.tag}>{t.inReview}</span>}
        {!changelog && (r.priority === 'high' || r.priority === 'blocking') && <span style={s.tag}>{r.priority}</span>}
        <span>{day(changelog ? r.updatedAt : r.createdAt)}</span>
        {r.prUrl && <FixLink url={r.prUrl} t={t} />}
      </div>
      {changelog && r.resolution ? (
        <>
          <p style={s.main}>{r.resolution}</p>
          <p style={s.sub}>{t.askedFor} {r.description}</p>
        </>
      ) : (
        <p style={s.main}>{r.description}</p>
      )}
      {r.screenshots?.length ? (
        <div style={s.shots}>
          {r.screenshots.map((src, i) => (
            <button
              key={src}
              type="button"
              aria-label={`Preview screenshot ${i + 1}`}
              onClick={() => onShot?.(i)}
              style={{ padding: 0, border: 0, background: 'none', cursor: 'zoom-in' }}
            >
              <img src={src} alt={shotAlt(src) ?? `Screenshot ${i + 1}`} loading="lazy" style={s.shot} />
            </button>
          ))}
        </div>
      ) : null}
    </li>
  );
}

const s: Record<string, CSSProperties> = {
  // Type comes from the page (font family, size, line height); sizes here are relative to it.
  wrap: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '2.5em', font: 'inherit', lineHeight: 1.5, minWidth: 0 },
  h2: { margin: '0 0 0.15em', fontSize: '1.5em', lineHeight: 1.2 },
  muted: { margin: '0 0 0.8em', fontSize: '0.9em', opacity: 0.65 },
  bar: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: '0.6em', marginBottom: '-1.2em' },
  barTabs: { borderBottom: '1px solid rgba(128,128,128,0.25)' },
  underTabs: { display: 'flex', flexWrap: 'wrap', gap: '1.4em' },
  // Longhands only, with the colour always set: mixing the border shorthand with a changing
  // borderBottomColor left a grey line under every tab once it had been current (report 2c9034d0).
  underTab: { font: 'inherit', fontSize: '0.9em', padding: '0.4em 0', margin: '0 0 -1px', borderTopWidth: 0, borderLeftWidth: 0, borderRightWidth: 0, borderBottomWidth: 2, borderBottomStyle: 'solid', borderBottomColor: 'transparent', background: 'none', color: 'inherit', opacity: 0.6, cursor: 'pointer' },
  underTabOn: { opacity: 1, fontWeight: 600 },
  filters: { display: 'inline-flex', flexWrap: 'wrap', gap: '0.4em', marginLeft: 'auto' },
  search: { font: 'inherit', fontSize: '0.78em', padding: '0.15em 0.5em', border: '1px solid rgba(128,128,128,0.3)', borderRadius: 999, background: 'transparent', color: 'inherit', minWidth: 0, maxWidth: '14em' },
  day: { display: 'grid', gap: '0.4em', marginTop: '0.6em' },
  dayHead: { margin: 0, fontSize: '0.8em', fontWeight: 600, opacity: 0.6 },
  picker: { fontSize: '0.75em', opacity: 0.7, whiteSpace: 'nowrap' },
  pickBtn: { font: 'inherit', padding: '0 0.3em', border: 0, background: 'none', color: 'inherit', opacity: 0.6, cursor: 'pointer' },
  pickOn: { opacity: 1, fontWeight: 600 },
  row: { display: 'flex', alignItems: 'center', gap: '0.6em', minWidth: 0, padding: '0.4em 0.2em', borderBottom: '1px solid rgba(128,128,128,0.18)', fontSize: '0.92em' },
  rowText: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  rowDate: { flex: 'none', fontSize: '0.85em', opacity: 0.6 },
  listCompact: { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 0, minWidth: 0 },
  list: { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '0.75em' },
  item: { padding: '0.8em 1em', border: '1px solid rgba(128,128,128,0.25)', borderRadius: 10 },
  meta: { display: 'flex', flexWrap: 'wrap', gap: '0.5em', alignItems: 'center', fontSize: '0.8em', opacity: 0.8, marginBottom: '0.35em' },
  tag: { padding: '0 0.55em', border: '1px solid rgba(128,128,128,0.4)', borderRadius: 999 },
  main: { margin: 0, whiteSpace: 'pre-wrap' },
  done: { opacity: 0.5 },
  // Pills, as Chinat prefers them to an underlined tab row.
  tabs: { display: 'inline-flex', flexWrap: 'wrap', gap: 4, padding: 3, border: '1px solid rgba(128,128,128,0.3)', borderRadius: 999 },
  tab: { font: 'inherit', fontSize: '0.85em', padding: '0.25em 0.9em', border: 0, borderRadius: 999, background: 'none', color: 'inherit', cursor: 'pointer' },
  count: { marginLeft: '0.45em', fontWeight: 400, opacity: 0.7, fontSize: '0.9em' },
  shots: { display: 'flex', flexWrap: 'wrap', gap: '0.5em', marginTop: '0.6em' },
  shot: { display: 'block', height: 72, maxWidth: 160, objectFit: 'cover', borderRadius: 6, border: '1px solid rgba(128,128,128,0.3)' },
  sub: { margin: '0.35em 0 0', fontSize: '0.85em', opacity: 0.65, whiteSpace: 'pre-wrap' },
};
