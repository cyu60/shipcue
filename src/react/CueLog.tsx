import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from 'react';
import { useLightbox } from './Lightbox';
import { PinIcon } from './PinIcon';
import { starredFirst, useStars } from './stars';
import { fixLabel } from './fixLink';
import { OutlinePreview, isOutlineText } from './outline';
import { conflictsOf, describeOverlaps, otherSide, PRIORITIES, REPORT_TYPES, shotAlt, type ClaimConflict, PRIORITY_LABEL, TYPE_LABEL, sortQueue, type Area, type Claimant, type Priority, type Report, type ReportEvent, type ReportType, type Status } from '../core';

// The CueLog: the team's table of every report, worked by people and agents together.
// Reads and writes the handler's team API ({endpoint}/team/...), so it needs the `team` option.

export interface CueLogMember {
  id: string;
  name: string;
  role: 'owner' | 'member' | 'viewer';
}

export type CueLogTab = 'open' | 'mine' | 'starred' | 'in_review' | 'fixed' | 'all';
export type CueLogSort = 'queue' | 'waiting' | 'updated' | 'claimant';
/** '' anyone · 'me' · 'none' nobody yet · 'unlooked' nobody has looked · 'agents' · 'people' · or "kind:id" for one claimant. */
export type ClaimantFilter = string;

export interface CueLogFilter {
  tab: CueLogTab;
  type?: ReportType | '';
  priority?: Priority | '';
  claimant?: ClaimantFilter;
  search?: string;
}

export const CUELOG_TEXT = {
  title: 'CueLog',
  tabs: { open: 'Open', mine: 'Mine', starred: 'Pinned', in_review: 'In review', fixed: 'Fixed', all: 'All' } as Record<CueLogTab, string>,
  status: { open: 'Open', claimed: 'Claimed', in_review: 'In review', fixed: 'Fixed', wontfix: "Won't fix" } as Record<Status, string>,
  nobody: 'Nobody yet',
  nobodyLooked: 'Nobody has looked',
  queuedFor: 'Queued for',
  list: 'List',
  board: 'Board',
  empty: 'Nothing here.',
  signIn: 'Sign in to see the CueLog.',
  claim: 'Claim',
  release: 'Release',
  fixed: 'Fixed',
  wontfix: "Won't fix",
  reopen: 'Reopen',
  review: 'In review',
  prUrl: 'PR link',
  resolution: 'What was done, or why not',
  copyPrompt: 'Copy agent prompt',
  copied: 'Copied',
  history: 'History',
  addNote: 'Add note',
  notePlaceholder: 'A note for the team or the next agent',
  // The hosted agent's suggestions on its note (shipcue report 1c0bf5be).
  applyPriority: 'Apply priority',
  applyArea: 'Apply area',
  mergeInto: 'Merge into',
  stale: 'stale',
  lease: 'lease',
  selected: 'selected',
  assignTo: 'Assign to…',
  setPriority: 'Priority…',
  close: 'Close',
  // Edit a filed report, and the line that says what changed (shipcue report 5c54da74).
  edit: 'Edit',
  save: 'Save',
  cancel: 'Cancel',
  reportText: 'Report text',
  type: 'Type',
  area: 'Area',
  whatChanged: 'What changed',
  copyLink: 'Copy link',
  linkCopied: 'Link copied',
  context: 'Context',
  preview: 'Preview',
  raw: 'Raw',
  search: 'Search',
  keysHint: '/ search · j k move · ↵ open · p pin · Esc close',
  // Two active claims whose work areas overlap (shipcue report 83f5d976).
  overlaps: 'overlaps',
};
export type CueLogText = typeof CUELOG_TEXT;

const DAY = 86_400_000;
// A video the button sends right after the report moves updatedAt; that is still the reporter, not the team.
const FILING_GRACE_MS = 120_000;

/**
 * Nobody has looked (shipcue report e4e1a85e): open, nobody holds it or has it queued, and nothing has
 * happened to it since it was filed. A claim, an assignment, a note, a priority or an edit all move
 * updatedAt, so an untouched report still has the updatedAt it was filed with.
 */
export function nobodyLooked(r: Report): boolean {
  if (r.status !== 'open' || r.claimantId != null || r.claimedBy != null) return false;
  return Date.parse(r.updatedAt ?? r.createdAt) - Date.parse(r.createdAt) <= FILING_GRACE_MS;
}

/** Which reports a tab and the filters keep. `stars`: the ids starred in this browser. */
export function filterReports(reports: readonly Report[], f: CueLogFilter, me: string | null, stars: readonly string[] = []): Report[] {
  const q = (f.search ?? '').trim().toLowerCase();
  return reports.filter((r) => {
    if (f.tab === 'open' && !['open', 'claimed'].includes(r.status)) return false;
    if (f.tab === 'mine' && (r.claimantId !== me || ['fixed', 'wontfix'].includes(r.status))) return false;
    if (f.tab === 'starred' && !stars.includes(r.id)) return false;
    if (f.tab === 'in_review' && r.status !== 'in_review') return false;
    if (f.tab === 'fixed' && !['fixed', 'wontfix'].includes(r.status)) return false;
    if (f.type && r.type !== f.type) return false;
    if (f.priority && r.priority !== f.priority) return false;
    const c = f.claimant ?? '';
    if (c === 'me' && r.claimantId !== me) return false;
    if (c === 'none' && r.claimantId != null) return false;
    if (c === 'unlooked' && !nobodyLooked(r)) return false;
    if (c === 'agents' && r.claimantKind !== 'agent') return false;
    if (c === 'people' && r.claimantKind !== 'person') return false;
    if (c.includes(':') && `${r.claimantKind}:${r.claimantId}` !== c) return false;
    if (q && !`${r.description} ${r.area} ${r.reporter ?? ''} ${r.claimedBy ?? ''}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

export function sortReports(reports: readonly Report[], sort: CueLogSort): Report[] {
  if (sort === 'queue') return sortQueue(reports);
  const list = [...reports];
  if (sort === 'waiting') return list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (sort === 'updated') return list.sort((a, b) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt));
  return list.sort((a, b) => (a.claimedBy ?? '￿').localeCompare(b.claimedBy ?? '￿') || a.createdAt.localeCompare(b.createdAt));
}

/** "3h", "2d": how long ago, short. */
export function ago(iso: string, now = Date.now()): string {
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (m < 60) return `${m}m`;
  if (m < 60 * 24) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 60 / 24)}d`;
}

const headline = (r: Report) => (r.description.trim().split('\n')[0] ?? '').slice(0, 120);
const claimantKey = (c: Pick<Claimant, 'kind' | 'id'>) => `${c.kind}:${c.id}`;

export interface CueLogTableProps {
  /** Where the handler is mounted, e.g. "/api/shipcue". It must be created with the `team` option. */
  endpoint?: string;
  /** Re-read when something changes: checks {endpoint}/team/version this often (ms). 0 turns it off. */
  liveMs?: number;
  /** A person's claim gets a "stale" badge after this many days without an update. */
  staleDays?: number;
  initialTab?: CueLogTab;
  /** Areas' labels, from your shipcue config, so rows show "Editor" rather than "editor". */
  areas?: { value: string; label: string }[];
  text?: Partial<CueLogText>;
  /** Credentials for the team API calls; 'include' when the CueLog is on another origin. */
  credentials?: RequestCredentials;
  /**
   * Keep the tab and the open report in the page's URL (?tab=fixed&report=<id>), so either can be
   * linked and survives a reload, and the drawer gets Copy link. Off by default: it writes to your URL.
   */
  syncUrl?: boolean;
  /** Keys: / search, j and k move, Enter opens, p pins, Esc closes. Off by default: they listen on the page. */
  hotkeys?: boolean;
  className?: string;
  style?: CSSProperties;
}

/** The team's CueLog: a table (or board) of every report, claimed and worked by people and agents. */
export function CueLogTable({
  endpoint = '/api/shipcue',
  liveMs = 5_000,
  staleDays = 3,
  initialTab = 'open',
  areas = [],
  text: textProp,
  credentials = 'same-origin',
  syncUrl = false,
  hotkeys = false,
  className,
  style,
}: CueLogTableProps) {
  const t = { ...CUELOG_TEXT, ...textProp };
  const api = endpoint.replace(/\/$/, '') + '/team';
  const [member, setMember] = useState<CueLogMember | null>(null);
  const [claimants, setClaimants] = useState<Claimant[]>([]);
  const [reports, setReports] = useState<Report[] | null>(null);
  const [conflicts, setConflicts] = useState<ClaimConflict[]>([]);
  const [error, setError] = useState<string | null>(null);
  const fromUrl = useState(() => (syncUrl ? readUrl() : {}))[0];
  const [filter, setFilter] = useState<CueLogFilter>({ tab: fromUrl.tab ?? initialTab, type: '', priority: '', claimant: '', search: '' });
  const [meAreas, setMeAreas] = useState<Area[]>([]);
  const [cursor, setCursor] = useState(-1);
  const searchRef = useRef<HTMLInputElement>(null);
  const [sort, setSort] = useState<CueLogSort>('queue');
  const [view, setView] = useState<'list' | 'board'>('list');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(fromUrl.report ?? null);
  const canEdit = member != null && member.role !== 'viewer';
  const st = useStars();

  const load = useCallback(async () => {
    const [meRes, listRes] = await Promise.all([fetch(`${api}/me`, { credentials }), fetch(`${api}/reports`, { credentials })]);
    if (meRes.status === 401 || listRes.status === 401) {
      setError(t.signIn);
      return;
    }
    if (!meRes.ok || !listRes.ok) throw new Error('Could not load the CueLog.');
    const me = (await meRes.json()) as { member: CueLogMember; claimants: Claimant[]; areas?: Area[] };
    setMember(me.member);
    setClaimants(me.claimants);
    if (Array.isArray(me.areas)) setMeAreas(me.areas);
    setReports(((await listRes.json()) as { reports: Report[] }).reports);
    setError(null);
    // Overlapping work areas; an older handler without team/conflicts just shows none.
    try {
      const res = await fetch(`${api}/conflicts`, { credentials });
      setConflicts(res.ok ? ((await res.json()) as { conflicts?: ClaimConflict[] }).conflicts ?? [] : []);
    } catch {
      setConflicts([]);
    }
  }, [api, credentials, t.signIn]);

  useEffect(() => {
    load().catch((e: Error) => setError(e.message));
  }, [load]);

  useEffect(() => {
    if (!liveMs) return;
    let last: string | null = null;
    const tick = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const res = await fetch(`${api}/version`, { credentials, cache: 'no-store' });
        if (!res.ok) return;
        const { version } = (await res.json()) as { version: string };
        if (last !== null && version !== last) await load();
        last = version;
      } catch {
        // Offline for a moment: try again next tick.
      }
    };
    void tick();
    const timer = setInterval(tick, liveMs);
    return () => clearInterval(timer);
  }, [api, credentials, liveMs, load]);

  /** POST an action; the returned report replaces the row. */
  const act = useCallback(
    async (id: string, action: string, body: Record<string, unknown> = {}) => {
      const res = await fetch(`${api}/reports/${encodeURIComponent(id)}/${action}`, {
        method: 'POST',
        credentials,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { report?: Report; into?: Report; error?: string };
      if (!res.ok || !data.report) {
        setError(data.error ?? 'That did not work.');
        return null;
      }
      setError(null);
      // A merge also changes the report it went into.
      setReports((list) => list?.map((r) => (r.id === id ? data.report! : r.id === data.into?.id ? data.into : r)) ?? list);
      return data.report;
    },
    [api, credentials],
  );

  const assign = (id: string, key: string) => {
    const to = key ? claimants.find((c) => claimantKey(c) === key) : null;
    return act(id, 'assign', { to: to ? { kind: to.kind, id: to.id } : null });
  };

  const shown = useMemo(
    () => (reports ? starredFirst(sortReports(filterReports(reports, filter, member?.id ?? null, st.stars), sort), st.stars) : []),
    [reports, filter, sort, member, st.stars],
  );
  const counts = useMemo(() => {
    const all = reports ?? [];
    const n = (tab: CueLogTab) => filterReports(all, { tab }, member?.id ?? null, st.stars).length;
    return { open: n('open'), mine: n('mine'), starred: n('starred'), in_review: n('in_review'), fixed: n('fixed'), all: all.length } as Record<CueLogTab, number>;
  }, [reports, member, st.stars]);
  // The app's areas when it passes them, else the handler's config (from /team/me).
  const areaList = areas.length > 0 ? areas : meAreas;
  const areaLabel = (v: string) => areaList.find((a) => a.value === v)?.label ?? v;

  // The tab and the open report live in the URL, so a report can be linked (Habitect's /reports?id=).
  useEffect(() => {
    if (syncUrl) writeUrl(filter.tab === initialTab ? null : filter.tab, open);
  }, [syncUrl, filter.tab, open, initialTab]);

  // Keys, as on Habitect's /reports: / search, j k move, Enter or o opens, p pins.
  const keyState = useRef({ shown, cursor, open });
  keyState.current = { shown, cursor, open };
  useEffect(() => {
    if (!hotkeys) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      const { shown, cursor, open } = keyState.current;
      if (open) return; // The drawer has the keys (Esc closes it).
      if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === 'j' || e.key === 'k') {
        e.preventDefault();
        setCursor(Math.max(0, Math.min(shown.length - 1, cursor + (e.key === 'j' ? 1 : -1))));
      } else if ((e.key === 'Enter' || e.key === 'o') && shown[cursor]) {
        e.preventDefault();
        setOpen(shown[cursor].id);
      } else if (e.key === 'p' && shown[cursor]) {
        e.preventDefault();
        st.toggle(shown[cursor].id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hotkeys, st]);

  const bulk = async (fn: (id: string) => Promise<unknown>) => {
    for (const id of selected) await fn(id);
    setSelected(new Set());
  };

  if (error && !reports) return <p style={s.muted}>{error}</p>;
  if (!reports) return <p style={s.muted}>Loading…</p>;
  const current = open ? reports.find((r) => r.id === open) ?? null : null;

  return (
    <div className={className} style={{ ...s.wrap, ...style }}>
      <div style={s.bar}>
        <div style={s.pills} role="tablist">
          {(Object.keys(t.tabs) as CueLogTab[]).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={filter.tab === tab}
              style={{ ...s.pill, ...(filter.tab === tab ? s.pillOn : {}) }}
              onClick={() => setFilter({ ...filter, tab })}
            >
              {t.tabs[tab]}
              <span style={s.count}>{counts[tab]}</span>
            </button>
          ))}
        </div>
        <div style={s.pills}>
          {(['list', 'board'] as const).map((v) => (
            <button key={v} type="button" style={{ ...s.pill, ...(view === v ? s.pillOn : {}) }} onClick={() => setView(v)}>
              {t[v]}
            </button>
          ))}
        </div>
      </div>

      <div style={s.filters}>
        <input ref={searchRef} type="search" aria-label={t.search} placeholder={t.search} value={filter.search} onChange={(e) => setFilter({ ...filter, search: e.target.value })} style={s.input} />
        <select aria-label="Type" value={filter.type} onChange={(e) => setFilter({ ...filter, type: e.target.value as ReportType | '' })} style={s.select}>
          <option value="">All types</option>
          {(Object.keys(TYPE_LABEL) as ReportType[]).map((k) => (
            <option key={k} value={k}>
              {TYPE_LABEL[k]}
            </option>
          ))}
        </select>
        <select aria-label="Priority" value={filter.priority} onChange={(e) => setFilter({ ...filter, priority: e.target.value as Priority | '' })} style={s.select}>
          <option value="">Any priority</option>
          {[...PRIORITIES].reverse().map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABEL[p]}
            </option>
          ))}
        </select>
        <select aria-label="Claimed by" value={filter.claimant} onChange={(e) => setFilter({ ...filter, claimant: e.target.value })} style={s.select}>
          <option value="">Anyone</option>
          <option value="me">Me</option>
          <option value="none">{t.nobody}</option>
          <option value="unlooked">{t.nobodyLooked}</option>
          <option value="agents">Any agent</option>
          <option value="people">Any person</option>
          {claimants.map((c) => (
            <option key={claimantKey(c)} value={claimantKey(c)}>
              {c.kind === 'agent' ? '🤖 ' : ''}
              {c.name}
            </option>
          ))}
        </select>
        <select aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value as CueLogSort)} style={s.select}>
          <option value="queue">Queue order</option>
          <option value="waiting">Longest waiting</option>
          <option value="updated">Recently updated</option>
          <option value="claimant">Claimed by</option>
        </select>
      </div>

      {hotkeys && <p style={s.hint}>{t.keysHint}</p>}
      {error && <p style={s.error}>{error}</p>}

      {canEdit && selected.size > 0 && (
        <div style={s.bulk}>
          <span>
            {selected.size} {t.selected}
          </span>
          <select aria-label="Assign selected" value="" onChange={(e) => void bulk((id) => assign(id, e.target.value === '-' ? '' : e.target.value))} style={s.select}>
            <option value="">{t.assignTo}</option>
            <option value="-">{t.nobody}</option>
            {claimants.map((c) => (
              <option key={claimantKey(c)} value={claimantKey(c)}>
                {c.name}
              </option>
            ))}
          </select>
          <select aria-label="Priority for selected" value="" onChange={(e) => e.target.value && void bulk((id) => act(id, 'priority', { priority: e.target.value }))} style={s.select}>
            <option value="">{t.setPriority}</option>
            {[...PRIORITIES].reverse().map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABEL[p]}
              </option>
            ))}
          </select>
          <button type="button" style={s.btn} onClick={() => void bulk((id) => act(id, 'release'))}>
            {t.release}
          </button>
          <button type="button" style={s.btn} onClick={() => void bulk((id) => act(id, 'close', { status: 'fixed' }))}>
            {t.fixed}
          </button>
          <button type="button" style={s.btn} onClick={() => void bulk((id) => act(id, 'close', { status: 'wontfix' }))}>
            {t.wontfix}
          </button>
        </div>
      )}

      {view === 'list' ? (
        shown.length === 0 ? (
          <p style={s.muted}>{t.empty}</p>
        ) : (
          <div style={s.scroll}>
            <table style={s.table}>
              <thead>
                <tr>
                  {canEdit && (
                    <th style={s.th}>
                      <input
                        type="checkbox"
                        aria-label="Select all"
                        checked={shown.length > 0 && shown.every((r) => selected.has(r.id))}
                        onChange={(e) => setSelected(e.target.checked ? new Set(shown.map((r) => r.id)) : new Set())}
                      />
                    </th>
                  )}
                  <th style={s.th} aria-label="Pinned" />
                  <th style={s.th}>Report</th>
                  <th style={s.th}>Priority</th>
                  <th style={s.th}>Status</th>
                  <th style={s.th}>Claimed by</th>
                  <th style={s.th}>Area</th>
                  <th style={s.th}>Waiting</th>
                  <th style={s.th}>Updated</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r, i) => (
                  <tr key={r.id} style={i === cursor ? { ...s.tr, ...s.trOn } : s.tr} aria-selected={i === cursor} onMouseDown={() => setCursor(i)}>
                    {canEdit && (
                      <td style={s.td}>
                        <input
                          type="checkbox"
                          aria-label={`Select ${headline(r)}`}
                          checked={selected.has(r.id)}
                          onChange={(e) => {
                            const next = new Set(selected);
                            if (e.target.checked) next.add(r.id);
                            else next.delete(r.id);
                            setSelected(next);
                          }}
                        />
                      </td>
                    )}
                    <td style={s.td}>
                      <button
                        type="button"
                        aria-label={st.isStarred(r.id) ? `Unpin ${headline(r)}` : `Pin ${headline(r)}`}
                        aria-pressed={st.isStarred(r.id)}
                        onClick={() => st.toggle(r.id)}
                        style={{ ...s.link, opacity: st.isStarred(r.id) ? 1 : 0.45 }}
                      >
                        <PinIcon on={st.isStarred(r.id)} size={13} />
                      </button>
                    </td>
                    <td style={{ ...s.td, ...s.headline }}>
                      <button type="button" style={s.link} onClick={() => setOpen(r.id)} title={r.description}>
                        <span style={s.type}>{TYPE_LABEL[r.type]}</span> {headline(r)}
                      </button>
                      {r.prUrl && (
                        <a href={r.prUrl} target="_blank" rel="noopener noreferrer" style={s.prLink} title={r.prUrl}>
                          {fixLabel(r.prUrl)} ↗
                        </a>
                      )}
                      {conflictsOf(conflicts, r.id).map((c) => {
                        const o = otherSide(c, r.id);
                        return (
                          <span key={o.id} style={{ ...s.badge, ...s.nobody, marginLeft: '0.4em' }} title={`${o.claimedBy ?? ''}: ${describeOverlaps(c.overlaps)}`}>
                            {t.overlaps} #{o.id.slice(0, 8)}
                          </span>
                        );
                      })}
                    </td>
                    <td style={s.td}>
                      <select
                        aria-label="Priority"
                        disabled={!canEdit}
                        value={r.priority}
                        onChange={(e) => void act(r.id, 'priority', { priority: e.target.value })}
                        style={{ ...s.cell, ...(r.priority === 'blocking' || r.priority === 'high' ? s.hot : {}) }}
                      >
                        {[...PRIORITIES].reverse().map((p) => (
                          <option key={p} value={p}>
                            {PRIORITY_LABEL[p]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td style={s.td}>
                      <StatusTag r={r} t={t} />
                    </td>
                    <td style={s.td}>
                      <ClaimantCell r={r} t={t} claimants={claimants} canEdit={canEdit} staleDays={staleDays} onAssign={(key) => void assign(r.id, key)} />
                    </td>
                    <td style={{ ...s.td, ...s.dim }}>{areaLabel(r.area)}</td>
                    <td style={{ ...s.td, ...s.dim }}>{ago(r.createdAt)}</td>
                    <td style={{ ...s.td, ...s.dim }}>{ago(r.updatedAt ?? r.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : (
        <BoardView reports={shown} t={t} canEdit={canEdit} onOpen={setOpen} act={act} />
      )}

      {current && (
        <Drawer
          key={current.id}
          r={current}
          api={api}
          credentials={credentials}
          t={t}
          canEdit={canEdit}
          claimants={claimants}
          areaLabel={areaLabel}
          areas={areaList}
          linkable={syncUrl}
          onClose={() => setOpen(null)}
          act={act}
          onAssign={(key) => void assign(current.id, key)}
        />
      )}
    </div>
  );
}

const TABS: readonly CueLogTab[] = ['open', 'mine', 'starred', 'in_review', 'fixed', 'all'];

/** The tab and open report from ?tab= and ?report=, when there is a page to read. */
function readUrl(): { tab?: CueLogTab; report?: string } {
  if (typeof window === 'undefined') return {};
  const q = new URL(window.location.href).searchParams;
  const tab = TABS.find((x) => x === q.get('tab'));
  const report = q.get('report') ?? undefined;
  return { ...(tab ? { tab } : {}), ...(report ? { report } : {}) };
}

/** Puts the tab and the open report in the URL without a new history entry. */
function writeUrl(tab: CueLogTab | null, report: string | null) {
  try {
    const url = new URL(window.location.href);
    const set = (k: string, v: string | null) => (v ? url.searchParams.set(k, v) : url.searchParams.delete(k));
    set('tab', tab);
    set('report', report);
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, '', url);
  } catch {
    // No URL to update (a sandboxed frame): the table still works.
  }
}

/** A link to one report on this page. */
function reportLink(id: string): string {
  const url = new URL(window.location.href);
  url.searchParams.set('report', id);
  return url.href;
}

/** True while someone types in a field, so single-letter keys stay letters. */
function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

function StatusTag({ r, t }: { r: Report; t: CueLogText }) {
  return <span style={{ ...s.tag, ...(r.status === 'in_review' ? s.tagReview : {}), ...(['fixed', 'wontfix'].includes(r.status) ? s.dim : {}) }}>{t.status[r.status]}</span>;
}

function ClaimantCell({
  r,
  t,
  claimants,
  canEdit,
  staleDays,
  onAssign,
}: {
  r: Report;
  t: CueLogText;
  claimants: Claimant[];
  canEdit: boolean;
  staleDays: number;
  onAssign: (key: string) => void;
}) {
  const key = r.claimantKind && r.claimantId ? `${r.claimantKind}:${r.claimantId}` : '';
  const known = claimants.some((c) => claimantKey(c) === key);
  const queued = r.status === 'open' && r.claimantKind === 'agent';
  const stale = r.claimantKind === 'person' && r.status === 'claimed' && Date.now() - Date.parse(r.updatedAt ?? r.createdAt) > staleDays * DAY;
  const leaseLeft = r.leaseExpiresAt ? Math.max(0, Math.round((Date.parse(r.leaseExpiresAt) - Date.now()) / 60_000)) : null;
  return (
    <span style={s.claimant}>
      {canEdit && !['fixed', 'wontfix', 'in_review'].includes(r.status) ? (
        <select aria-label="Claimed by" value={key} onChange={(e) => onAssign(e.target.value)} style={{ ...s.cell, ...(key ? {} : s.nobody) }}>
          <option value="">{t.nobody}</option>
          {!known && key && <option value={key}>{r.claimedBy}</option>}
          {claimants.map((c) => (
            <option key={claimantKey(c)} value={claimantKey(c)}>
              {c.kind === 'agent' ? '🤖 ' : ''}
              {c.name}
            </option>
          ))}
        </select>
      ) : (
        <span style={key ? undefined : s.nobody}>
          {r.claimantKind === 'agent' ? '🤖 ' : ''}
          {r.claimedBy ?? t.nobody}
        </span>
      )}
      {queued && <span style={s.badge}>{t.queuedFor.toLowerCase()}</span>}
      {stale && <span style={{ ...s.badge, ...s.nobody }}>{t.stale}</span>}
      {leaseLeft !== null && r.status === 'claimed' && (
        <span style={s.badge} title={r.leaseExpiresAt ?? ''}>
          {t.lease} {leaseLeft}m
        </span>
      )}
    </span>
  );
}

const BOARD_COLUMNS: { status: Status; drop?: (id: string, act: Act) => unknown }[] = [
  { status: 'open', drop: (id, act) => act(id, 'release') },
  { status: 'claimed', drop: (id, act) => act(id, 'claim') },
  { status: 'in_review' },
  { status: 'fixed', drop: (id, act) => act(id, 'close', { status: 'fixed' }) },
];
type Act = (id: string, action: string, body?: Record<string, unknown>) => Promise<Report | null>;

function BoardView({ reports, t, canEdit, onOpen, act }: { reports: Report[]; t: CueLogText; canEdit: boolean; onOpen: (id: string) => void; act: Act }) {
  const [over, setOver] = useState<Status | null>(null);
  const onDrop = (col: (typeof BOARD_COLUMNS)[number]) => (e: DragEvent) => {
    e.preventDefault();
    setOver(null);
    const id = e.dataTransfer.getData('text/plain');
    if (id && col.drop) void col.drop(id, act);
  };
  return (
    <div style={s.board}>
      {BOARD_COLUMNS.map((col) => {
        const cards = reports.filter((r) => r.status === col.status || (col.status === 'fixed' && r.status === 'wontfix'));
        return (
          <section
            key={col.status}
            style={{ ...s.column, ...(over === col.status ? s.columnOver : {}) }}
            onDragOver={(e) => {
              if (canEdit && col.drop) {
                e.preventDefault();
                setOver(col.status);
              }
            }}
            onDragLeave={() => setOver(null)}
            onDrop={onDrop(col)}
          >
            <h3 style={s.colHead}>
              {t.status[col.status]} <span style={s.count}>{cards.length}</span>
            </h3>
            {cards.map((r) => (
              <button
                key={r.id}
                type="button"
                draggable={canEdit}
                onDragStart={(e) => e.dataTransfer.setData('text/plain', r.id)}
                onClick={() => onOpen(r.id)}
                style={s.card}
              >
                <span style={s.cardMeta}>
                  {TYPE_LABEL[r.type]} · {PRIORITY_LABEL[r.priority]} · {ago(r.createdAt)}
                </span>
                <span>{headline(r)}</span>
                <span style={{ ...s.cardMeta, ...(r.claimedBy ? {} : s.nobody) }}>
                  {r.claimantKind === 'agent' ? '🤖 ' : ''}
                  {r.claimedBy ?? t.nobody}
                </span>
              </button>
            ))}
          </section>
        );
      })}
    </div>
  );
}

function Drawer({
  r,
  api,
  credentials,
  t,
  canEdit,
  claimants,
  areaLabel,
  areas,
  linkable,
  onClose,
  act,
  onAssign,
}: {
  r: Report;
  api: string;
  credentials: RequestCredentials;
  t: CueLogText;
  canEdit: boolean;
  claimants: Claimant[];
  areaLabel: (v: string) => string;
  areas: Area[];
  linkable: boolean;
  onClose: () => void;
  act: Act;
  onAssign: (key: string) => void;
}) {
  const [detail, setDetail] = useState<{ report?: Report; prompt: string; events: ReportEvent[] } | null>(null);
  const [editing, setEditing] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [raw, setRaw] = useState(false);
  const [resolution, setResolution] = useState('');
  const [pr, setPr] = useState(r.prUrl ?? '');
  const [copied, setCopied] = useState(false);
  const [note, setNote] = useState('');
  const lb = useLightbox('Attachment');
  useEffect(() => {
    let live = true;
    fetch(`${api}/reports/${encodeURIComponent(r.id)}`, { credentials })
      .then((res) => (res.ok ? res.json() : null))
      .then((d: { report?: Report; prompt: string; events: ReportEvent[] } | null) => live && d && setDetail(d))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [api, credentials, r.id, r.updatedAt]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const closed = r.status === 'fixed' || r.status === 'wontfix';
  // The list leaves diagnostics out; the report's own read has them.
  const diagnostics = detail?.report?.diagnostics ?? r.diagnostics ?? {};
  const outline = !!r.context && isOutlineText(r.context);

  return (
    <aside style={s.drawer} aria-label="Report">
      <div style={s.drawerHead}>
        <span style={s.cardMeta}>
          {TYPE_LABEL[r.type]} · {PRIORITY_LABEL[r.priority]} · {areaLabel(r.area)} · <StatusTag r={r} t={t} />
        </span>
        <button type="button" style={s.btn} onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      {editing ? (
        <EditForm r={r} t={t} areas={areas} closed={closed} onCancel={() => setEditing(false)} onSave={(patch) => act(r.id, 'edit', patch).then((saved) => saved && setEditing(false))} />
      ) : (
        <p style={s.desc}>{r.description}</p>
      )}
      {r.context && (
        <details>
          <summary style={s.small}>{t.context}</summary>
          {outline && (
            <span role="radiogroup" aria-label={t.context} style={s.switch}>
              {([false, true] as const).map((v) => (
                <button key={String(v)} type="button" role="radio" aria-checked={raw === v} onClick={() => setRaw(v)} style={{ ...s.link, ...(raw === v ? s.on : s.dim) }}>
                  {v ? t.raw : t.preview}
                </button>
              ))}
            </span>
          )}
          {outline && !raw ? (
            <div style={s.pre}>
              <OutlinePreview text={r.context} />
            </div>
          ) : (
            <pre style={s.pre}>{r.context}</pre>
          )}
        </details>
      )}
      {r.screenshots.length > 0 && (
        <div style={s.shots}>
          {r.screenshots.map((src, i) => (
            <button key={src} type="button" aria-label={`Preview attachment ${i + 1}`} onClick={() => lb.open(r.screenshots, i)} style={{ ...s.link, cursor: 'zoom-in' }}>
              <img src={src} alt={shotAlt(src) ?? `Attachment ${i + 1}`} style={s.shot} />
            </button>
          ))}
        </div>
      )}
      {r.video && (
        <a href={r.video} target="_blank" rel="noopener noreferrer" style={s.small}>
          Video
        </a>
      )}
      <dl style={s.dl}>
        <dt>Claimed by</dt>
        <dd>
          <ClaimantCell r={r} t={t} claimants={claimants} canEdit={canEdit} staleDays={Infinity} onAssign={onAssign} />
        </dd>
        <dt>Reporter</dt>
        <dd>{r.reporter ?? '—'}</dd>
        {r.pageUrl && (
          <>
            <dt>Page</dt>
            <dd style={s.ellipsis}>
              <a href={r.pageUrl} target="_blank" rel="noopener noreferrer">
                {r.pageUrl}
              </a>
            </dd>
          </>
        )}
        {r.prUrl && (
          <>
            <dt>PR</dt>
            <dd style={s.ellipsis}>
              <a href={r.prUrl} target="_blank" rel="noopener noreferrer">
                {r.prUrl}
              </a>
            </dd>
          </>
        )}
        {r.resolution && (
          <>
            <dt>Resolution</dt>
            <dd>{r.resolution}</dd>
          </>
        )}
        <dt>Filed</dt>
        <dd>{new Date(r.createdAt).toLocaleString()}</dd>
      </dl>
      {Object.keys(diagnostics).length > 0 && (
        <details>
          <summary style={s.small}>App snapshot</summary>
          <pre style={s.pre}>{JSON.stringify(diagnostics, null, 2)}</pre>
        </details>
      )}

      <span style={s.inline}>
        {canEdit && !editing && (
          <button type="button" style={s.btn} onClick={() => setEditing(true)}>
            {t.edit}
          </button>
        )}
        {linkable && (
          <button
            type="button"
            style={s.btn}
            aria-label={t.copyLink}
            onClick={() => void navigator.clipboard?.writeText(reportLink(r.id)).then(() => setLinkCopied(true))}
          >
            {linkCopied ? t.linkCopied : t.copyLink}
          </button>
        )}
      </span>

      {canEdit && (
        <div style={s.actions}>
          {r.status === 'open' && (
            <button type="button" style={s.btn} onClick={() => void act(r.id, 'claim')}>
              {t.claim}
            </button>
          )}
          {(r.status === 'claimed' || r.status === 'in_review' || (r.status === 'open' && r.claimantId)) && (
            <button type="button" style={s.btn} onClick={() => void act(r.id, 'release')}>
              {t.release}
            </button>
          )}
          {closed || r.status === 'in_review' ? (
            <button type="button" style={s.btn} onClick={() => void act(r.id, 'reopen')}>
              {t.reopen}
            </button>
          ) : (
            <span style={s.inline}>
              <input aria-label={t.prUrl} placeholder={t.prUrl} value={pr} onChange={(e) => setPr(e.target.value)} style={s.input} />
              <button type="button" style={s.btn} disabled={!pr} onClick={() => void act(r.id, 'review', { prUrl: pr })}>
                {t.review}
              </button>
            </span>
          )}
          {!closed && (
            <span style={s.inline}>
              <input aria-label={t.resolution} placeholder={t.resolution} value={resolution} onChange={(e) => setResolution(e.target.value)} style={s.input} />
              <button type="button" style={s.btn} onClick={() => void act(r.id, 'close', { status: 'fixed', resolution: resolution || null })}>
                {t.fixed}
              </button>
              <button type="button" style={s.btn} onClick={() => void act(r.id, 'close', { status: 'wontfix', resolution: resolution || null })}>
                {t.wontfix}
              </button>
            </span>
          )}
        </div>
      )}

      {detail && (
        <>
          <button
            type="button"
            style={s.btn}
            onClick={() => {
              void navigator.clipboard?.writeText(detail.prompt).then(() => setCopied(true));
            }}
          >
            {copied ? t.copied : t.copyPrompt}
          </button>
          <h4 style={s.small}>{t.history}</h4>
          <ol style={s.timeline}>
            <li>Filed {ago(r.createdAt)} ago</li>
            {detail.events.map((e) => (
              <li key={e.id}>
                {e.actor ? `${e.actor.kind === 'agent' ? '🤖 ' : ''}${e.actor.name} ` : ''}
                {eventText(e)} · {ago(e.at)} ago
                {/* Notes show in full (shipcue report 3d2dded6). */}
                {e.action === 'note' && typeof e.detail.text === 'string' && <div style={s.note}>{e.detail.text}</div>}
                {canEdit && e.action === 'note' && <SuggestionChips raw={e.detail.suggest} r={r} areas={areas} areaLabel={areaLabel} t={t} act={act} />}
              </li>
            ))}
          </ol>
          {canEdit && (
            <span style={s.inline}>
              <textarea aria-label={t.addNote} placeholder={t.notePlaceholder} value={note} onChange={(e) => setNote(e.target.value)} rows={2} style={{ ...s.input, flex: 1, minWidth: '12em' }} />
              <button
                type="button"
                style={s.btn}
                disabled={!note.trim()}
                onClick={() => void act(r.id, 'note', { text: note }).then((saved) => saved && setNote(''))}
              >
                {t.addNote}
              </button>
            </span>
          )}
        </>
      )}
      {lb.box}
    </aside>
  );
}

export interface Suggestion {
  priority?: Priority;
  area?: string;
  duplicateOf?: string;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The hosted agent's suggestions on a note, kept to what makes sense for the report now: a known
 * priority or area it does not already have, and another report's id while this one is still open.
 * Null when nothing is left (shipcue report 1c0bf5be).
 */
export function readSuggestion(raw: unknown, r: Pick<Report, 'id' | 'priority' | 'area' | 'status'>, areas: readonly Area[]): Suggestion | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  const out: Suggestion = {};
  const priority = PRIORITIES.find((p) => p === d.priority);
  if (priority && priority !== r.priority) out.priority = priority;
  if (typeof d.area === 'string' && d.area !== r.area && areas.some((a) => a.value === d.area)) out.area = d.area;
  if (typeof d.duplicateOf === 'string' && UUID.test(d.duplicateOf) && d.duplicateOf !== r.id && r.status !== 'fixed' && r.status !== 'wontfix') out.duplicateOf = d.duplicateOf;
  return Object.keys(out).length ? out : null;
}

/** Small Apply chips under a note; each goes through the team API under the member, so it is logged. */
function SuggestionChips({ raw, r, areas, areaLabel, t, act }: { raw: unknown; r: Report; areas: Area[]; areaLabel: (v: string) => string; t: CueLogText; act: Act }) {
  const sg = readSuggestion(raw, r, areas);
  if (!sg) return null;
  return (
    <span style={{ ...s.inline, margin: '0 0 0.3em' }}>
      {sg.priority && (
        <button type="button" style={s.chip} onClick={() => void act(r.id, 'priority', { priority: sg.priority })}>
          {t.applyPriority}: {PRIORITY_LABEL[sg.priority]}
        </button>
      )}
      {sg.area && (
        <button type="button" style={s.chip} onClick={() => void act(r.id, 'edit', { area: sg.area })}>
          {t.applyArea}: {areaLabel(sg.area)}
        </button>
      )}
      {sg.duplicateOf && (
        <button type="button" style={s.chip} onClick={() => void act(r.id, 'merge', { into: sg.duplicateOf })}>
          {t.mergeInto} #{sg.duplicateOf.slice(0, 8)}
        </button>
      )}
    </span>
  );
}

function eventText(e: ReportEvent): string {
  const to = e.detail.to as Claimant | null | undefined;
  switch (e.action) {
    case 'claimed':
      return 'claimed it';
    case 'assigned':
      return to ? `assigned it to ${to.name}` : 'unassigned it';
    case 'released':
      return 'released it';
    case 'expired':
      return "'s lease ran out";
    case 'review':
      return 'opened a PR';
    case 'closed':
      return e.detail.status === 'wontfix' ? "closed it as won't fix" : 'closed it as fixed';
    case 'reopened':
      return 'reopened it';
    case 'priority':
      return `set priority to ${String(e.detail.priority)}`;
    case 'note':
      return 'added a note';
    case 'edited':
      return 'edited it';
  }
}

/** Rewrite a filed report: its text, type and area, and once closed, what changed. */
function EditForm({
  r,
  t,
  areas,
  closed,
  onCancel,
  onSave,
}: {
  r: Report;
  t: CueLogText;
  areas: Area[];
  closed: boolean;
  onCancel: () => void;
  onSave: (patch: Record<string, unknown>) => Promise<unknown>;
}) {
  const [description, setDescription] = useState(r.description);
  const [type, setType] = useState<ReportType>(r.type);
  const [area, setArea] = useState(r.area);
  const [resolution, setResolution] = useState(r.resolution ?? '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    // Only what changed goes up, so the history names the right fields.
    const patch: Record<string, unknown> = {};
    if (description.trim() !== r.description.trim()) patch.description = description;
    if (type !== r.type) patch.type = type;
    if (area !== r.area) patch.area = area;
    if (closed && resolution.trim() !== (r.resolution ?? '').trim()) patch.resolution = resolution;
    if (Object.keys(patch).length === 0) return onCancel();
    setBusy(true);
    await onSave(patch);
    setBusy(false);
  };
  return (
    <form
      style={s.actions}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      onKeyDown={(e) => {
        // Esc cancels the edit and stops there, so the drawer stays open; ⌘↵ saves.
        if (e.key === 'Escape') {
          e.stopPropagation();
          onCancel();
        } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void save();
        }
      }}
    >
      <textarea aria-label={t.reportText} value={description} onChange={(e) => setDescription(e.target.value)} rows={5} style={{ ...s.input, width: '100%', boxSizing: 'border-box' }} autoFocus />
      <span style={s.inline}>
        <select aria-label={t.type} value={type} onChange={(e) => setType(e.target.value as ReportType)} style={s.select}>
          {REPORT_TYPES.map((k) => (
            <option key={k} value={k}>
              {TYPE_LABEL[k]}
            </option>
          ))}
        </select>
        {areas.length > 0 && (
          <select aria-label={t.area} value={area} onChange={(e) => setArea(e.target.value)} style={s.select}>
            {!areas.some((a) => a.value === area) && <option value={area}>{area}</option>}
            {areas.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
        )}
      </span>
      {closed && (
        <textarea aria-label={t.whatChanged} placeholder={t.whatChanged} value={resolution} onChange={(e) => setResolution(e.target.value)} rows={2} style={{ ...s.input, width: '100%', boxSizing: 'border-box' }} />
      )}
      <span style={s.inline}>
        <button type="submit" style={s.btn} disabled={busy || !description.trim()}>
          {t.save}
        </button>
        <button type="button" style={s.btn} onClick={onCancel}>
          {t.cancel}
        </button>
      </span>
    </form>
  );
}

const line = '1px solid rgba(128,128,128,0.22)';
const s: Record<string, CSSProperties> = {
  // Small and quiet: type comes from the page, sizes are relative to it.
  wrap: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '0.8em', font: 'inherit', fontSize: '0.92em', lineHeight: 1.45, minWidth: 0 },
  bar: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: '0.6em' },
  pills: { display: 'inline-flex', flexWrap: 'wrap', gap: 3, padding: 3, border: line, borderRadius: 999 },
  pill: { font: 'inherit', fontSize: '0.85em', padding: '0.2em 0.8em', border: 0, borderRadius: 999, background: 'none', color: 'inherit', cursor: 'pointer' },
  pillOn: { background: 'rgba(128,128,128,0.16)', fontWeight: 600 },
  count: { marginLeft: '0.4em', fontWeight: 400, opacity: 0.6, fontSize: '0.9em' },
  filters: { display: 'flex', flexWrap: 'wrap', gap: '0.4em' },
  input: { font: 'inherit', fontSize: '0.85em', padding: '0.2em 0.5em', border: line, borderRadius: 6, background: 'transparent', color: 'inherit', minWidth: 0 },
  select: { font: 'inherit', fontSize: '0.85em', padding: '0.15em 0.3em', border: line, borderRadius: 6, background: 'transparent', color: 'inherit' },
  cell: { font: 'inherit', fontSize: '0.95em', padding: '0.05em 0.2em', border: '1px solid transparent', borderRadius: 4, background: 'transparent', color: 'inherit', cursor: 'pointer', maxWidth: '12em' },
  btn: { font: 'inherit', fontSize: '0.82em', padding: '0.15em 0.65em', border: line, borderRadius: 999, background: 'transparent', color: 'inherit', cursor: 'pointer' },
  bulk: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.4em', padding: '0.35em 0.6em', border: line, borderRadius: 8, fontSize: '0.9em' },
  scroll: { overflowX: 'auto', minWidth: 0 },
  table: { width: '100%', borderCollapse: 'collapse' },
  th: { textAlign: 'left', fontSize: '0.72em', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', opacity: 0.55, padding: '0.4em 0.5em', borderBottom: line, whiteSpace: 'nowrap' },
  tr: { borderBottom: line },
  trOn: { background: 'rgba(128,128,128,0.08)' },
  prLink: { marginLeft: '0.5em', fontSize: '0.78em', opacity: 0.7, color: 'inherit', whiteSpace: 'nowrap' },
  hint: { margin: 0, fontSize: '0.75em', opacity: 0.5 },
  switch: { display: 'inline-flex', gap: '0.6em', marginLeft: '0.8em', fontSize: '0.78em' },
  on: { fontWeight: 600 },
  td: { padding: '0.35em 0.5em', verticalAlign: 'middle', whiteSpace: 'nowrap' },
  headline: { whiteSpace: 'normal', minWidth: '16em', maxWidth: '32em' },
  link: { font: 'inherit', padding: 0, border: 0, background: 'none', color: 'inherit', textAlign: 'left', cursor: 'pointer' },
  type: { fontSize: '0.78em', opacity: 0.6, marginRight: '0.3em' },
  hot: { fontWeight: 600 },
  dim: { opacity: 0.6 },
  tag: { display: 'inline-block', padding: '0 0.55em', border: '1px solid rgba(128,128,128,0.4)', borderRadius: 999, fontSize: '0.82em' },
  tagReview: { borderColor: 'rgba(46,91,255,0.55)' },
  claimant: { display: 'inline-flex', alignItems: 'center', gap: '0.35em' },
  // "Nobody yet" in amber, as the Stanford Founders dashboard shows unowned work.
  nobody: { color: '#B45309' },
  badge: { fontSize: '0.72em', padding: '0 0.45em', border: '1px solid rgba(128,128,128,0.35)', borderRadius: 999, opacity: 0.8 },
  muted: { margin: 0, opacity: 0.65 },
  error: { margin: 0, color: '#B91C1C', fontSize: '0.9em' },
  board: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(13em, 1fr))', gap: '0.6em', alignItems: 'start' },
  column: { display: 'grid', gap: '0.4em', padding: '0.5em', border: line, borderRadius: 10, minHeight: '6em' },
  columnOver: { background: 'rgba(128,128,128,0.08)' },
  colHead: { margin: 0, fontSize: '0.8em', fontWeight: 600 },
  card: { display: 'grid', gap: '0.2em', textAlign: 'left', font: 'inherit', fontSize: '0.9em', padding: '0.5em 0.6em', border: line, borderRadius: 8, background: 'transparent', color: 'inherit', cursor: 'pointer' },
  cardMeta: { fontSize: '0.78em', opacity: 0.7 },
  drawer: {
    position: 'fixed',
    top: 0,
    right: 0,
    bottom: 0,
    width: 'min(30em, 100vw)',
    overflowY: 'auto',
    padding: '1em',
    display: 'grid',
    alignContent: 'start',
    gap: '0.7em',
    background: 'Canvas',
    color: 'CanvasText',
    borderLeft: line,
    boxShadow: '-8px 0 24px rgba(0,0,0,0.12)',
    zIndex: 50,
  },
  drawerHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5em' },
  desc: { margin: 0, whiteSpace: 'pre-wrap' },
  small: { margin: 0, fontSize: '0.82em', fontWeight: 600, opacity: 0.75, cursor: 'pointer' },
  pre: { margin: '0.3em 0 0', padding: '0.5em', fontSize: '0.78em', whiteSpace: 'pre-wrap', wordBreak: 'break-word', border: line, borderRadius: 6 },
  shots: { display: 'flex', flexWrap: 'wrap', gap: '0.4em' },
  shot: { display: 'block', height: 64, maxWidth: 140, objectFit: 'cover', borderRadius: 6, border: line },
  dl: { display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', gap: '0.25em 0.8em', margin: 0, fontSize: '0.88em' },
  ellipsis: { margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  actions: { display: 'grid', gap: '0.4em', justifyItems: 'start' },
  inline: { display: 'inline-flex', flexWrap: 'wrap', gap: '0.3em', alignItems: 'center' },
  timeline: { margin: 0, paddingLeft: '1.1em', fontSize: '0.85em', display: 'grid', gap: '0.2em' },
  chip: { font: 'inherit', fontSize: '0.8em', padding: '0.05em 0.6em', border: '1px solid rgba(128,128,128,0.45)', borderRadius: 999, background: 'transparent', color: 'inherit', cursor: 'pointer' },
  note: { margin: '0.2em 0 0.3em', padding: '0.4em 0.55em', whiteSpace: 'pre-wrap', wordBreak: 'break-word', border: line, borderRadius: 6 },
};
