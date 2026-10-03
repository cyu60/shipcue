import { useCallback, useEffect, useMemo, useState, type CSSProperties, type DragEvent } from 'react';
import { PRIORITIES, PRIORITY_LABEL, TYPE_LABEL, sortQueue, type Claimant, type Priority, type Report, type ReportEvent, type ReportType, type Status } from '../core';

// The CueLog: the team's table of every report, worked by people and agents together.
// Reads and writes the handler's team API ({endpoint}/team/...), so it needs the `team` option.

export interface CueLogMember {
  id: string;
  name: string;
  role: 'owner' | 'member' | 'viewer';
}

export type CueLogTab = 'open' | 'mine' | 'in_review' | 'fixed' | 'all';
export type CueLogSort = 'queue' | 'waiting' | 'updated' | 'claimant';
/** '' anyone · 'me' · 'none' nobody yet · 'agents' · 'people' · or "kind:id" for one claimant. */
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
  tabs: { open: 'Open', mine: 'Mine', in_review: 'In review', fixed: 'Fixed', all: 'All' } as Record<CueLogTab, string>,
  status: { open: 'Open', claimed: 'Claimed', in_review: 'In review', fixed: 'Fixed', wontfix: "Won't fix" } as Record<Status, string>,
  nobody: 'Nobody yet',
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
  stale: 'stale',
  lease: 'lease',
  selected: 'selected',
  assignTo: 'Assign to…',
  setPriority: 'Priority…',
  close: 'Close',
};
export type CueLogText = typeof CUELOG_TEXT;

const DAY = 86_400_000;

/** Which reports a tab and the filters keep. */
export function filterReports(reports: readonly Report[], f: CueLogFilter, me: string | null): Report[] {
  const q = (f.search ?? '').trim().toLowerCase();
  return reports.filter((r) => {
    if (f.tab === 'open' && !['open', 'claimed'].includes(r.status)) return false;
    if (f.tab === 'mine' && (r.claimantId !== me || ['fixed', 'wontfix'].includes(r.status))) return false;
    if (f.tab === 'in_review' && r.status !== 'in_review') return false;
    if (f.tab === 'fixed' && !['fixed', 'wontfix'].includes(r.status)) return false;
    if (f.type && r.type !== f.type) return false;
    if (f.priority && r.priority !== f.priority) return false;
    const c = f.claimant ?? '';
    if (c === 'me' && r.claimantId !== me) return false;
    if (c === 'none' && r.claimantId != null) return false;
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
  className,
  style,
}: CueLogTableProps) {
  const t = { ...CUELOG_TEXT, ...textProp };
  const api = endpoint.replace(/\/$/, '') + '/team';
  const [member, setMember] = useState<CueLogMember | null>(null);
  const [claimants, setClaimants] = useState<Claimant[]>([]);
  const [reports, setReports] = useState<Report[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<CueLogFilter>({ tab: initialTab, type: '', priority: '', claimant: '', search: '' });
  const [sort, setSort] = useState<CueLogSort>('queue');
  const [view, setView] = useState<'list' | 'board'>('list');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const canEdit = member != null && member.role !== 'viewer';

  const load = useCallback(async () => {
    const [meRes, listRes] = await Promise.all([fetch(`${api}/me`, { credentials }), fetch(`${api}/reports`, { credentials })]);
    if (meRes.status === 401 || listRes.status === 401) {
      setError(t.signIn);
      return;
    }
    if (!meRes.ok || !listRes.ok) throw new Error('Could not load the CueLog.');
    const me = (await meRes.json()) as { member: CueLogMember; claimants: Claimant[] };
    setMember(me.member);
    setClaimants(me.claimants);
    setReports(((await listRes.json()) as { reports: Report[] }).reports);
    setError(null);
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
      const data = (await res.json().catch(() => ({}))) as { report?: Report; error?: string };
      if (!res.ok || !data.report) {
        setError(data.error ?? 'That did not work.');
        return null;
      }
      setError(null);
      setReports((list) => list?.map((r) => (r.id === id ? data.report! : r)) ?? list);
      return data.report;
    },
    [api, credentials],
  );

  const assign = (id: string, key: string) => {
    const to = key ? claimants.find((c) => claimantKey(c) === key) : null;
    return act(id, 'assign', { to: to ? { kind: to.kind, id: to.id } : null });
  };

  const shown = useMemo(() => (reports ? sortReports(filterReports(reports, filter, member?.id ?? null), sort) : []), [reports, filter, sort, member]);
  const counts = useMemo(() => {
    const all = reports ?? [];
    const n = (tab: CueLogTab) => filterReports(all, { tab }, member?.id ?? null).length;
    return { open: n('open'), mine: n('mine'), in_review: n('in_review'), fixed: n('fixed'), all: all.length } as Record<CueLogTab, number>;
  }, [reports, member]);
  const areaLabel = (v: string) => areas.find((a) => a.value === v)?.label ?? v;

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
        <input aria-label="Search" placeholder="Search" value={filter.search} onChange={(e) => setFilter({ ...filter, search: e.target.value })} style={s.input} />
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
                {shown.map((r) => (
                  <tr key={r.id} style={s.tr}>
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
                    <td style={{ ...s.td, ...s.headline }}>
                      <button type="button" style={s.link} onClick={() => setOpen(r.id)} title={r.description}>
                        <span style={s.type}>{TYPE_LABEL[r.type]}</span> {headline(r)}
                      </button>
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
          onClose={() => setOpen(null)}
          act={act}
          onAssign={(key) => void assign(current.id, key)}
        />
      )}
    </div>
  );
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
  onClose: () => void;
  act: Act;
  onAssign: (key: string) => void;
}) {
  const [detail, setDetail] = useState<{ prompt: string; events: ReportEvent[] } | null>(null);
  const [resolution, setResolution] = useState('');
  const [pr, setPr] = useState(r.prUrl ?? '');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let live = true;
    fetch(`${api}/reports/${encodeURIComponent(r.id)}`, { credentials })
      .then((res) => (res.ok ? res.json() : null))
      .then((d: { prompt: string; events: ReportEvent[] } | null) => live && d && setDetail(d))
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
      <p style={s.desc}>{r.description}</p>
      {r.context && (
        <details>
          <summary style={s.small}>Context</summary>
          <pre style={s.pre}>{r.context}</pre>
        </details>
      )}
      {r.screenshots.length > 0 && (
        <div style={s.shots}>
          {r.screenshots.map((src, i) => (
            <a key={src} href={src} target="_blank" rel="noopener noreferrer">
              <img src={src} alt={`Attachment ${i + 1}`} style={s.shot} />
            </a>
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
      {Object.keys(r.diagnostics ?? {}).length > 0 && (
        <details>
          <summary style={s.small}>App snapshot</summary>
          <pre style={s.pre}>{JSON.stringify(r.diagnostics, null, 2)}</pre>
        </details>
      )}

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
              </li>
            ))}
          </ol>
        </>
      )}
    </aside>
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
  }
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
};
