// My reports at /app/mine/ (shipcue report 3d0d7995): the signed-in shipcue Cloud account's own
// reports on shipcue's queue, with where each stands and how it was fixed, on any device. Reads
// GET /api/shipcue/mine (api.mjs turns on reporterPortal: its reporter is the Cloud session).
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { fixLabel } from '../../src/react/fixLink';

const STATUS = { open: 'Open', claimed: 'In progress', in_review: 'In review', fixed: 'Fixed', wontfix: "Won't fix" };
const TYPE = { bug: 'Bug', feature: 'Feature request', task: 'Agent task' };
// The public CueLog lists open, in-progress, in-review and fixed reports; a link lands on the one.
const ON_CUELOG = ['open', 'claimed', 'in_review', 'fixed'];
const day = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

const s = {
  list: { listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 10 },
  item: { background: 'var(--white)', border: '1px solid var(--line)', borderRadius: 12, padding: '14px 16px', display: 'grid', gap: 6 },
  meta: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', fontSize: 13, color: 'var(--muted)' },
  tag: { fontSize: 12, padding: '1px 8px', border: '1px solid var(--line)', borderRadius: 999 },
  title: { margin: 0, fontSize: 16, fontWeight: 600 },
  fix: { margin: 0, fontSize: 15 },
  muted: { fontSize: 15, color: 'var(--muted)' },
};

export function MyReports({ endpoint = '/api/shipcue' }) {
  const [state, setState] = useState({ phase: 'loading' });
  useEffect(() => {
    let live = true;
    fetch(`${endpoint}/mine`, { cache: 'no-store', credentials: 'same-origin' })
      .then(async (res) => {
        if (res.status === 401) return { phase: 'signedOut' };
        if (!res.ok) return { phase: 'error' };
        return { phase: 'ready', reports: (await res.json()).reports ?? [] };
      })
      .catch(() => ({ phase: 'error' }))
      .then((next) => live && setState(next));
    return () => {
      live = false;
    };
  }, [endpoint]);

  if (state.phase === 'loading') return <p style={s.muted}>Loading…</p>;
  if (state.phase === 'error') return <p style={s.muted}>Could not load your reports. Try again in a moment.</p>;
  if (state.phase === 'signedOut')
    return (
      <p style={s.muted}>
        <a href="/app/?next=%2Fapp%2Fmine%2F">Sign in</a> to see the reports you sent to shipcue, on any device.
      </p>
    );
  if (!state.reports.length)
    return <p style={s.muted}>Nothing yet. Reports you send to shipcue with the button while signed in show up here.</p>;
  return (
    <ul style={s.list} aria-label="My reports">
      {state.reports.map((r) => (
        <li key={r.id} style={s.item}>
          <div style={s.meta}>
            <span style={s.tag}>{TYPE[r.type] ?? r.type}</span>
            <span style={{ ...s.tag, ...(r.status === 'fixed' ? { borderColor: 'var(--ink)', color: 'var(--ink)' } : {}) }}>{STATUS[r.status] ?? r.status}</span>
            <span>Sent {day(r.createdAt)}</span>
            {r.status !== 'open' && <span>· updated {day(r.updatedAt)}</span>}
            {r.prUrl && /^https:\/\//.test(r.prUrl) && (
              <a href={r.prUrl} target="_blank" rel="noopener noreferrer">
                {fixLabel(r.prUrl)} ↗
              </a>
            )}
            {ON_CUELOG.includes(r.status) && <a href={`/cuelog/?view=all#shipcue-${r.id}`}>On the CueLog</a>}
          </div>
          <p style={s.title}>{r.title}</p>
          {r.resolution && (
            <p style={s.fix}>
              <strong>What changed:</strong> {r.resolution}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

const el = typeof document !== 'undefined' ? document.getElementById('shipcue-mine') : null;
if (el) createRoot(el).render(<MyReports />);
