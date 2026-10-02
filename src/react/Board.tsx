import { useEffect, useState, type CSSProperties } from 'react';
import { TYPE_LABEL, type Board, type BoardItem } from '../core';

export interface ShipcueBoardProps {
  /** Where the handler is mounted, e.g. "/api/shipcue" (it must be created with `board`). */
  endpoint?: string;
  /** Which lists to show. Both by default. */
  show?: 'both' | 'queue' | 'changelog';
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
  accentColor = '#16203A',
  refreshMs = 60_000,
  className,
  style,
}: ShipcueBoardProps) {
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  if (error && !board) return <p style={s.muted}>{error}</p>;
  if (!board) return <p style={s.muted}>Loading…</p>;

  return (
    <div className={className} style={{ ...s.wrap, ...style }}>
      {show !== 'changelog' && (
        <section>
          <h2 style={{ ...s.h2, color: accentColor }}>Queue</h2>
          <p style={s.muted}>{board.queue.length === 0 ? 'Nothing waiting.' : `${board.queue.length} open, most urgent first.`}</p>
          <ul style={s.list}>
            {board.queue.map((r) => (
              <Item key={r.id} r={r} accent={accentColor} />
            ))}
          </ul>
        </section>
      )}
      {show !== 'queue' && (
        <section>
          <h2 style={{ ...s.h2, color: accentColor }}>Changelog</h2>
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

function Item({ r, accent, changelog = false }: { r: BoardItem; accent: string; changelog?: boolean }) {
  return (
    <li style={s.item}>
      <div style={s.meta}>
        <span style={{ ...s.tag, borderColor: accent, color: accent }}>{TYPE_LABEL[r.type]}</span>
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
    </li>
  );
}

const s: Record<string, CSSProperties> = {
  wrap: { display: 'grid', gap: 32, font: '14px/1.5 system-ui, -apple-system, Segoe UI, sans-serif' },
  h2: { margin: '0 0 2px', fontSize: 18 },
  muted: { margin: '0 0 10px', fontSize: 13, opacity: 0.65 },
  list: { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 10 },
  item: { padding: '10px 12px', border: '1px solid rgba(128,128,128,0.25)', borderRadius: 8 },
  meta: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', fontSize: 12, opacity: 0.8, marginBottom: 4 },
  tag: { padding: '0 6px', border: '1px solid rgba(128,128,128,0.4)', borderRadius: 999, fontSize: 11 },
  main: { margin: 0, whiteSpace: 'pre-wrap' },
  sub: { margin: '4px 0 0', fontSize: 12, opacity: 0.65, whiteSpace: 'pre-wrap' },
};
