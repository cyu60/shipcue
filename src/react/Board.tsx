import { useEffect, useState, type CSSProperties } from 'react';
import { TYPE_LABEL, type Board, type BoardItem } from '../core';

type View = 'open' | 'fixed' | 'all' | 'changelog';

export interface ShipcueBoardProps {
  /** Where the handler is mounted, e.g. "/api/shipcue" (it must be created with `board`). */
  endpoint?: string;
  /** Which lists to show. Both by default, as Open / Fixed / All / Changelog pills. */
  show?: 'both' | 'queue' | 'changelog';
  /** With show="both", the tab it starts on. 'queue' is the same as 'open'. */
  initialView?: View | 'queue';
  /** Heading color and the small accents. */
  accentColor?: string;
  /** Re-read the board this often while the page is open (ms). 0 turns it off. */
  refreshMs?: number;
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
  accentColor = '#16203A',
  refreshMs = 60_000,
  className,
  style,
}: ShipcueBoardProps) {
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>(initialView === 'queue' ? 'open' : initialView);

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
    return () => {
      live = false;
      if (timer) clearInterval(timer);
    };
  }, [endpoint, refreshMs]);

  if (error && !board) return <p className={className} style={{ ...s.muted, ...style }}>{error}</p>;
  if (!board) return <p className={className} style={{ ...s.muted, ...style }}>Loading…</p>;

  // With both lists, pill tabs: Open, Fixed, All, Changelog, with counts
  // (shipcue reports 9fdd0b45, 15720123).
  const TABS: { id: View; label: string; count?: number }[] = [
    { id: 'open', label: 'Open', count: board.queue.length },
    { id: 'fixed', label: 'Fixed', count: board.changelog.length },
    { id: 'all', label: 'All', count: board.queue.length + board.changelog.length },
    { id: 'changelog', label: 'Changelog' },
  ];
  const current: View | 'queue' = show === 'both' ? view : show;
  const list = (items: BoardItem[], done = false) => (
    <ul style={s.list}>
      {items.map((r) => (
        <Item key={r.id} r={r} accent={accentColor} done={done} />
      ))}
    </ul>
  );
  return (
    <div className={className} style={{ ...s.wrap, ...style }}>
      {show === 'both' && (
        <div role="tablist" aria-label="Reports" style={s.tabs}>
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={view === t.id}
              aria-label={t.count !== undefined ? `${t.label} ${t.count}` : t.label}
              onClick={() => setView(t.id)}
              style={view === t.id ? { ...s.tab, background: accentColor, color: '#fff' } : s.tab}
            >
              {t.label}
              {t.count !== undefined && <span style={s.count}>{t.count}</span>}
            </button>
          ))}
        </div>
      )}
      {current === 'open' && (
        <section>
          {board.queue.length === 0 ? <p style={s.muted}>Nothing waiting.</p> : list(board.queue)}
        </section>
      )}
      {current === 'fixed' && (
        <section>{board.changelog.length === 0 ? <p style={s.muted}>Nothing fixed yet.</p> : list(board.changelog, true)}</section>
      )}
      {current === 'all' && (
        <section>
          {list(board.queue)}
          {board.changelog.length > 0 && <div style={{ marginTop: '0.75em' }}>{list(board.changelog, true)}</div>}
        </section>
      )}
      {current === 'queue' && (
        <section>
          <h2 style={{ ...s.h2, color: accentColor }}>Queue</h2>
          <p style={s.muted}>
            {board.queue.length === 0 ? 'Nothing waiting.' : `${board.queue.length} open, most urgent first.`}
            {board.changelog.length > 0 ? ' Done ones stay below, greyed out.' : ''}
          </p>
          <ul style={s.list}>
            {board.queue.map((r) => (
              <Item key={r.id} r={r} accent={accentColor} />
            ))}
            {/* Finished ones stay in the queue, greyed out, so nothing seems to vanish. */}
            {board.changelog.map((r) => (
              <Item key={r.id} r={r} accent={accentColor} done />
            ))}
          </ul>
        </section>
      )}
      {current === 'changelog' && (
        <section>
          {show !== 'both' && <h2 style={{ ...s.h2, color: accentColor }}>Changelog</h2>}
          <p style={s.muted}>{board.changelog.length === 0 ? 'Nothing shipped yet.' : 'What was fixed, latest first.'}</p>
          <ul style={s.list}>
            {board.changelog.map((r) => (
              <Item key={r.id} r={r} accent={accentColor} changelog />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** Just the queue. */
export const ShipcueQueue = (props: Omit<ShipcueBoardProps, 'show'>) => <ShipcueBoard {...props} show="queue" />;
/** Just the changelog. */
export const ShipcueChangelog = (props: Omit<ShipcueBoardProps, 'show'>) => <ShipcueBoard {...props} show="changelog" />;

function day(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function Item({ r, accent, changelog = false, done = false }: { r: BoardItem; accent: string; changelog?: boolean; done?: boolean }) {
  return (
    <li style={done ? { ...s.item, ...s.done } : s.item}>
      <div style={s.meta}>
        <span style={{ ...s.tag, borderColor: accent, color: accent }}>{TYPE_LABEL[r.type]}</span>
        {done && <span style={s.tag}>Done</span>}
        {!changelog && r.status === 'claimed' && <span style={s.tag}>In progress</span>}
        {!changelog && (r.priority === 'high' || r.priority === 'blocking') && <span style={s.tag}>{r.priority}</span>}
        <span>{day(changelog ? r.updatedAt : r.createdAt)}</span>
      </div>
      {changelog && r.resolution ? (
        <>
          <p style={s.main}>{r.resolution}</p>
          <p style={s.sub}>Asked for: {r.description}</p>
        </>
      ) : (
        <p style={s.main}>{r.description}</p>
      )}
      {r.screenshots?.length ? (
        <div style={s.shots}>
          {r.screenshots.map((src, i) => (
            <a key={src} href={src} target="_blank" rel="noopener noreferrer" aria-label={`Screenshot ${i + 1}`}>
              <img src={src} alt={`Screenshot ${i + 1}`} loading="lazy" style={s.shot} />
            </a>
          ))}
        </div>
      ) : null}
    </li>
  );
}

const s: Record<string, CSSProperties> = {
  // Type comes from the page (font family, size, line height); sizes here are relative to it.
  wrap: { display: 'grid', gap: '2.5em', font: 'inherit', lineHeight: 1.5 },
  h2: { margin: '0 0 0.15em', fontSize: '1.5em', lineHeight: 1.2 },
  muted: { margin: '0 0 0.8em', fontSize: '0.9em', opacity: 0.65 },
  list: { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '0.75em' },
  item: { padding: '0.8em 1em', border: '1px solid rgba(128,128,128,0.25)', borderRadius: 10 },
  meta: { display: 'flex', flexWrap: 'wrap', gap: '0.5em', alignItems: 'center', fontSize: '0.8em', opacity: 0.8, marginBottom: '0.35em' },
  tag: { padding: '0 0.55em', border: '1px solid rgba(128,128,128,0.4)', borderRadius: 999 },
  main: { margin: 0, whiteSpace: 'pre-wrap' },
  done: { opacity: 0.5 },
  // Pills, as Chinat prefers them to an underlined tab row.
  tabs: { display: 'inline-flex', flexWrap: 'wrap', gap: 4, padding: 3, border: '1px solid rgba(128,128,128,0.3)', borderRadius: 999, justifySelf: 'start', marginBottom: '-1.2em' },
  tab: { font: 'inherit', fontSize: '0.85em', padding: '0.25em 0.9em', border: 0, borderRadius: 999, background: 'none', color: 'inherit', cursor: 'pointer' },
  count: { marginLeft: '0.45em', fontWeight: 400, opacity: 0.7, fontSize: '0.9em' },
  shots: { display: 'flex', flexWrap: 'wrap', gap: '0.5em', marginTop: '0.6em' },
  shot: { display: 'block', height: 72, maxWidth: 160, objectFit: 'cover', borderRadius: 6, border: '1px solid rgba(128,128,128,0.3)' },
  sub: { margin: '0.35em 0 0', fontSize: '0.85em', opacity: 0.65, whiteSpace: 'pre-wrap' },
};
