// Open what you sent (shipcue report fec27a48): the Yours list, each item opening a read-only
// view of the report as it was sent from this browser, with the server's status merged in when
// the handler offers GET /mine. The panel uses it for Yours; LocalReports shows it on a page.
import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { PRIORITY_LABEL, type Priority, type Status } from '../core';
import { fixLabel } from './fixLink';
import { isOutlineText, OutlinePreview } from './outline';
import { PinIcon } from './PinIcon';
import { starredFirst, useStars, type MyReport } from './stars';
import { fill, resolveText, type ShipcueText } from './text';

export const statusWords = (t: ShipcueText): Record<Status, string> => ({ open: t.open, claimed: t.inProgress, in_review: t.inReview, fixed: t.fixed, wontfix: t.wontFix });

const font = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
const s = {
  row: { display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' } as CSSProperties,
  link: { border: 0, background: 'transparent', color: '#71717a', padding: 0, fontSize: 11, cursor: 'pointer', fontFamily: font } as CSSProperties,
  open: { flex: 1, minWidth: 0, border: 0, background: 'transparent', padding: 0, font: 'inherit', color: 'inherit', textAlign: 'left', cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as CSSProperties,
  chip: { display: 'inline-block', padding: '1px 6px', border: '1px solid #e4e4e7', borderRadius: 999, background: '#fafafa', fontSize: 10, color: '#52525b' } as CSSProperties,
  label: { display: 'block', marginTop: 8, fontSize: 10, fontWeight: 500, color: '#71717a' } as CSSProperties,
  muted: { color: '#a1a1aa' } as CSSProperties,
  text: { margin: '2px 0 0', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12, lineHeight: 1.45, color: '#27272a' } as CSSProperties,
  context: { marginTop: 2, maxHeight: 160, overflowY: 'auto', padding: '6px 10px', border: '1px solid #e4e4e7', borderRadius: 8, background: '#fafafa', fontSize: 12, lineHeight: 1.45, color: '#27272a', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } as CSSProperties,
};

const day = (at: string) => new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const safeHttp = (u: string | null | undefined): u is string => !!u && /^https?:\/\//i.test(u);
const pathOf = (u: string) => {
  try {
    const url = new URL(u);
    return decodeURIComponent(url.pathname) + url.search;
  } catch {
    return u;
  }
};

interface Pins {
  isStarred: (id: string) => boolean;
  toggle: (id: string) => void;
}

function PinButton({ report, pins, t }: { report: MyReport; pins: Pins; t: ShipcueText }) {
  const on = pins.isStarred(report.id);
  return (
    <button type="button" aria-label={`${on ? t.unpin : t.pin} ${report.title}`} aria-pressed={on} onClick={() => pins.toggle(report.id)} style={{ ...s.link, color: on ? '#18181b' : '#a1a1aa' }}>
      <PinIcon on={on} size={12} />
    </button>
  );
}

export interface ReportDetailProps {
  report: MyReport;
  text: ShipcueText;
  pins: Pins;
  onBack: () => void;
  renderContext?: (text: string) => ReactNode;
}

/** One report as it was sent from this browser, read-only. */
export function ReportDetail({ report: r, text: t, pins, onBack, renderContext }: ReportDetailProps) {
  const typeLabel = r.typeLabel ?? ({ bug: t.bugTab, feature: t.featureTab, task: t.taskTab } as Record<string, string>)[r.type] ?? r.type;
  const counts = [
    r.screenshots ? (r.screenshots === 1 ? t.screenshotAttached : fill(t.screenshotsAttached, { n: r.screenshots })) : null,
    r.files ? (r.files === 1 ? t.fileAttached : fill(t.filesAttached, { n: r.files })) : null,
    r.video ? t.videoAttached : null,
  ].filter((x): x is string => !!x);
  const alts = (r.alts ?? []).map((a, i) => [i, a.trim()] as const).filter(([, a]) => a);
  const body = r.description && r.description.trim() !== r.title.trim() ? r.description : null;
  return (
    <div aria-label={t.reportDetails} style={{ fontFamily: font }}>
      <div style={{ ...s.row, justifyContent: 'space-between' }}>
        <button type="button" onClick={onBack} style={s.link}>
          <span aria-hidden="true">← </span>{t.back}
        </button>
        <PinButton report={r} pins={pins} t={t} />
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
        <span style={s.chip}>{typeLabel}</span>
        {r.priority && <span style={s.chip}>{PRIORITY_LABEL[r.priority as Priority] ?? r.priority}</span>}
        {(r.areaLabel || r.area) && <span style={s.chip}>{r.areaLabel || r.area}</span>}
        {r.status && <span style={{ ...s.chip, ...(r.status === 'fixed' ? { color: '#18181b', borderColor: '#d4d4d8' } : null) }}>{statusWords(t)[r.status]}</span>}
      </div>
      <p style={{ ...s.text, fontWeight: 600, marginTop: 6 }}>{r.title}</p>
      {body && <p style={s.text}>{body}</p>}
      {(r.resolution || safeHttp(r.prUrl)) && (
        <p style={{ ...s.text, color: '#52525b' }}>
          {r.resolution && <span>{r.resolution}</span>}
          {r.resolution && safeHttp(r.prUrl) && ' · '}
          {safeHttp(r.prUrl) && (
            <a href={r.prUrl} target="_blank" rel="noopener noreferrer" style={{ color: '#71717a' }}>
              {fixLabel(r.prUrl)}
            </a>
          )}
        </p>
      )}
      {r.context && (
        <>
          <span style={s.label}>{t.context}</span>
          <div aria-label="Context preview" style={s.context}>
            {renderContext ? renderContext(r.context) : isOutlineText(r.context) ? <OutlinePreview text={r.context} /> : r.context}
          </div>
        </>
      )}
      {counts.length > 0 && (
        <p style={{ ...s.text, fontSize: 11, color: '#71717a', marginTop: 6 }}>
          {counts.map((c, i) => (
            <span key={c}>
              {i > 0 && ' · '}
              <span>{c}</span>
            </span>
          ))}
        </p>
      )}
      {alts.length > 0 && (
        <ul style={{ margin: '2px 0 0', paddingLeft: 16, fontSize: 11, color: '#71717a' }}>
          {alts.map(([i, a]) => (
            <li key={i}>
              {t.altText} {i + 1}: {a}
            </li>
          ))}
        </ul>
      )}
      <p style={{ ...s.text, fontSize: 10, ...s.muted, marginTop: 6 }}>
        {fill(t.filed, { when: new Date(r.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) })}
        {safeHttp(r.pageUrl) && (
          <>
            {' · '}
            {t.page}{' '}
            <a href={r.pageUrl} target="_blank" rel="noopener noreferrer" style={{ color: '#71717a' }}>
              {pathOf(r.pageUrl)}
            </a>
          </>
        )}
      </p>
    </div>
  );
}

export interface YoursListProps {
  items: readonly MyReport[];
  text: ShipcueText;
  pins: Pins;
  /** What to say when the list is empty. */
  empty: string;
  renderContext?: (text: string) => ReactNode;
  /** Shown under the list (the pin hint). */
  footer?: ReactNode;
}

/** The Yours list; each item opens its detail, Back returns. */
export function YoursList({ items, text: t, pins, empty, renderContext, footer }: YoursListProps) {
  const [openId, setOpenId] = useState<string | null>(null);
  const opened = openId ? items.find((m) => m.id === openId) : undefined;
  const words = statusWords(t);
  if (opened) return <ReportDetail report={opened} text={t} pins={pins} onBack={() => setOpenId(null)} renderContext={renderContext} />;
  return (
    <div aria-label={t.yourReports}>
      {items.length === 0 ? (
        <p style={{ margin: 0, fontSize: 10, ...s.muted }}>{empty}</p>
      ) : (
        items.map((m) => (
          <div key={m.id} style={s.row}>
            <PinButton report={m} pins={pins} t={t} />
            <button type="button" aria-label={fill(t.openIt, { title: m.title })} onClick={() => setOpenId(m.id)} style={s.open} title={m.resolution ? `${m.title}\n${m.resolution}` : m.title}>
              {m.title}
            </button>
            {m.status && <span style={{ color: m.status === 'fixed' ? '#18181b' : '#a1a1aa', flex: 'none' }}>{words[m.status]}</span>}
            {m.prUrl && /^https:\/\//.test(m.prUrl) && (
              <a href={m.prUrl} target="_blank" rel="noopener noreferrer" style={{ color: '#71717a', flex: 'none' }}>
                {fixLabel(m.prUrl)}
              </a>
            )}
            <span style={{ ...s.muted, flex: 'none' }}>{day(m.at)}</span>
          </div>
        ))
      )}
      {footer}
    </div>
  );
}

export interface LocalReportsProps {
  /** Your own words for any of shipcue's (the same keys as ReportButton's text). */
  text?: Partial<ShipcueText>;
  /** Draw the context your own way, as on ReportButton. */
  renderContext?: (text: string) => ReactNode;
  style?: CSSProperties;
}

/**
 * The reports sent from this browser, from local storage only: for a page whose ReportButton
 * uses a custom submit, or when offline. Pinned ones first; each opens read-only.
 */
export function LocalReports({ text, renderContext, style }: LocalReportsProps) {
  const t = useMemo(() => resolveText(text), [text]);
  const stars = useStars();
  return (
    <div style={{ fontSize: 12, color: '#3f3f46', fontFamily: font, ...style }}>
      <YoursList items={starredFirst(stars.mine, stars.stars)} text={t} pins={stars} empty={t.noReportsYet} renderContext={renderContext} />
    </div>
  );
}
