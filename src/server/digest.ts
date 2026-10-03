// Activity digest (shipcue report 5f4d339b): one batched summary per period instead of a message
// per event. Serverless has no timers, so it is a pure read of the report history plus a trigger:
// POST {base}/digest (the handler's `digest` option), called hourly or daily by a cron.
// A digest never carries who filed a report, the page, diagnostics or attachments.
import { TYPE_LABEL, type Priority, type Report, type ReportType } from '../core';
import type { EmailMessage } from './broadcast';
import type { ReportStore } from './store';

export type DigestFormat = 'slack' | 'email' | 'markdown';
export type DigestPeriod = 'hour' | 'day';
export const DIGEST_PERIOD_MS: Record<DigestPeriod, number> = { hour: 60 * 60 * 1000, day: 24 * 60 * 60 * 1000 };

/** One report as a digest shows it: what it is about, never who filed it. */
export interface DigestItem {
  id: string;
  type: ReportType;
  priority: Priority;
  /** The first line of the report, shortened. */
  text: string;
  /** Fixed: the fix line. */
  resolution?: string | null;
  prUrl?: string | null;
  /** Stuck: who holds it (or held it) and when the lease ran out. */
  claimedBy?: string | null;
  leaseExpiresAt?: string | null;
  /** Stuck: the lease ran out and the report went back to the queue in this period. */
  returned?: boolean;
  createdAt: string;
}

export interface DigestSummary {
  since: string;
  until: string;
  filed: DigestItem[];
  fixed: DigestItem[];
  reopened: DigestItem[];
  /** Claims held past their lease, and claims whose lease ran out in the period. */
  stuck: DigestItem[];
  /** Reports not yet fixed or closed: open, claimed or in review. */
  stillOpen: number;
  /** The open report that has waited longest. */
  oldest: DigestItem | null;
  /** Nothing was filed, fixed, reopened or stuck. */
  empty: boolean;
}

export interface DigestMessage {
  format: DigestFormat;
  /** A one-line subject, e.g. "shipcue digest: 2 filed, 1 fixed, 5 still open". */
  subject: string;
  /** The body: Slack mrkdwn, Markdown, or plain text for email. */
  text: string;
  /** Email only. */
  html?: string;
  summary: DigestSummary;
}

export interface DigestOptions {
  /** Start of the period (inclusive). */
  since: Date | string;
  /** End of the period (exclusive). Now by default. */
  until?: Date | string;
  format?: DigestFormat;
  /** The app's name in the heading. "shipcue" by default. */
  appName?: string;
  /** Where the queue can be seen, linked at the end. */
  link?: string;
}

const iso = (d: Date | string) => (typeof d === 'string' ? new Date(d) : d).toISOString();
const EMAIL_LIKE = /[^\s@<>"()[\]]+@[^\s@<>"()[\]]+\.[a-z]{2,}/gi;
/** Text a digest may show: one line, no email addresses, shortened. */
const clean = (t: string | null | undefined, max = 140) => {
  const line = (t ?? '').trim().split('\n')[0]!.replace(EMAIL_LIKE, '[email]').trim();
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
};
const safeLink = (u: string | null | undefined) => (u && /^https?:\/\/[^\s<>|]+$/i.test(u) ? u : null);

const item = (r: Report, extra: Partial<DigestItem> = {}): DigestItem => ({
  id: r.id,
  type: r.type,
  priority: r.priority,
  text: clean(r.description),
  createdAt: r.createdAt,
  ...extra,
});

/** Builds the period's summary from the store: the reports, and the history of those touched in it. */
export async function buildDigest(store: ReportStore, opts: Pick<DigestOptions, 'since' | 'until'>): Promise<DigestSummary> {
  const since = iso(opts.since);
  const until = iso(opts.until ?? new Date());
  const inPeriod = (t: string | null | undefined) => !!t && t >= since && t < until;
  const all = await store.list();

  const filed = all.filter((r) => inPeriod(r.createdAt)).map((r) => item(r));
  const fixed: DigestItem[] = [];
  const reopened: DigestItem[] = [];
  const stuck: DigestItem[] = [];
  const fixedItem = (r: Report) => item(r, { resolution: clean(r.resolution, 200) || null, prUrl: safeLink(r.prUrl) });

  // Only reports changed since the period began can have history in it.
  const touched = all.filter((r) => (r.updatedAt ?? r.createdAt) >= since);
  for (const r of touched) {
    if (!store.events) {
      if (r.status === 'fixed' && inPeriod(r.updatedAt)) fixed.push(fixedItem(r));
      continue;
    }
    const events = (await store.events(r.id)).filter((e) => inPeriod(e.at));
    if (events.some((e) => e.action === 'closed' && e.detail.status === 'fixed')) fixed.push(fixedItem(r));
    if (events.some((e) => e.action === 'reopened')) reopened.push(item(r));
    const expired = events.filter((e) => e.action === 'expired').pop();
    if (expired && r.status !== 'claimed') stuck.push(item(r, { claimedBy: clean(expired.actor?.name, 60) || null, leaseExpiresAt: null, returned: true }));
  }
  // Still held, with the lease run out by the end of the period.
  for (const r of all) {
    if (r.status === 'claimed' && r.leaseExpiresAt && r.leaseExpiresAt < until) {
      stuck.push(item(r, { claimedBy: clean(r.claimedBy, 60) || null, leaseExpiresAt: r.leaseExpiresAt, returned: false }));
    }
  }

  const open = all.filter((r) => r.status === 'open' || r.status === 'claimed' || r.status === 'in_review');
  const waiting = all.filter((r) => r.status === 'open' && r.createdAt < until).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))[0];
  return {
    since,
    until,
    filed,
    fixed,
    reopened,
    stuck,
    stillOpen: open.length,
    oldest: waiting ? item(waiting) : null,
    empty: !filed.length && !fixed.length && !reopened.length && !stuck.length,
  };
}

/** "3d", "5h", "12m". */
export function age(fromIso: string, toIso: string): string {
  const mins = Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 60000));
  if (mins < 60) return `${mins}m`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / 1440)}d`;
}
const when = (t: string) => `${t.slice(0, 10)} ${t.slice(11, 16)}`;
const period = (s: DigestSummary) =>
  s.since.slice(0, 10) === s.until.slice(0, 10) ? `${when(s.since)}–${s.until.slice(11, 16)} UTC` : `${when(s.since)} – ${when(s.until)} UTC`;

interface Line {
  text: string;
  link?: { url: string; label: string } | null;
}
interface Section {
  title: string;
  lines: Line[];
}

function sections(s: DigestSummary): Section[] {
  const kind = (i: DigestItem) => `${TYPE_LABEL[i.type]} (${i.priority})`;
  const out: Section[] = [];
  if (s.filed.length) out.push({ title: `Filed (${s.filed.length})`, lines: s.filed.map((i) => ({ text: `${kind(i)}: ${i.text}` })) });
  if (s.fixed.length) {
    out.push({
      title: `Fixed (${s.fixed.length})`,
      lines: s.fixed.map((i) => ({ text: i.resolution ? `${i.resolution} (${i.text})` : i.text, link: i.prUrl ? { url: i.prUrl, label: 'PR' } : null })),
    });
  }
  if (s.reopened.length) out.push({ title: `Reopened (${s.reopened.length})`, lines: s.reopened.map((i) => ({ text: `${kind(i)}: ${i.text}` })) });
  if (s.stuck.length) {
    out.push({
      title: `Stuck past the lease (${s.stuck.length})`,
      lines: s.stuck.map((i) => ({
        text: i.returned
          ? `${i.claimedBy ?? 'An agent'} let the lease run out, back in the queue: ${i.text}`
          : `${i.claimedBy ?? 'Someone'} still holds it, lease ran out ${i.leaseExpiresAt ? `${age(i.leaseExpiresAt, s.until)} ago` : ''}: ${i.text}`,
      })),
    });
  }
  return out;
}

const footer = (s: DigestSummary) =>
  `Still open: ${s.stillOpen}${s.oldest ? `. Oldest waiting (${age(s.oldest.createdAt, s.until)}): ${s.oldest.text}` : ''}`;

const subjectOf = (s: DigestSummary, appName: string) => {
  const parts = [
    s.filed.length && `${s.filed.length} filed`,
    s.fixed.length && `${s.fixed.length} fixed`,
    s.reopened.length && `${s.reopened.length} reopened`,
    s.stuck.length && `${s.stuck.length} stuck`,
  ].filter(Boolean);
  return `${appName} digest: ${parts.length ? `${parts.join(', ')}, ` : 'no new activity, '}${s.stillOpen} still open`;
};

const slackEsc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const htmlEsc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const mdEsc = (t: string) => t.replace(/([\\[\]`*_])/g, '\\$1');

/** Writes a summary as a Slack message, an email or Markdown (an Obsidian daily note, a Habitect log). */
export function formatDigest(s: DigestSummary, format: DigestFormat, opts: Pick<DigestOptions, 'appName' | 'link'> = {}): DigestMessage {
  const appName = opts.appName ?? 'shipcue';
  const link = safeLink(opts.link);
  const subject = subjectOf(s, appName);
  const secs = sections(s);
  if (format === 'slack') {
    const text = [
      `*${slackEsc(appName)} digest* · ${period(s)}`,
      ...secs.flatMap((sec) => [`*${sec.title}*`, ...sec.lines.map((l) => `• ${slackEsc(l.text)}${l.link ? ` <${l.link.url}|${l.link.label}>` : ''}`)]),
      ...(s.empty ? ['No new activity.'] : []),
      slackEsc(footer(s)),
      ...(link ? [`<${link}|Open the queue>`] : []),
    ].join('\n');
    return { format, subject, text, summary: s };
  }
  if (format === 'markdown') {
    const text = [
      `**${mdEsc(appName)} digest** · ${period(s)}`,
      ...secs.flatMap((sec) => [`- ${sec.title}`, ...sec.lines.map((l) => `  - ${mdEsc(l.text)}${l.link ? ` ([${l.link.label}](${l.link.url}))` : ''}`)]),
      ...(s.empty ? ['- No new activity.'] : []),
      `- ${mdEsc(footer(s))}`,
      ...(link ? [`- [Open the queue](${link})`] : []),
    ].join('\n');
    return { format, subject, text, summary: s };
  }
  const text = [
    `${appName} digest, ${period(s)}`,
    '',
    ...secs.flatMap((sec) => [sec.title, ...sec.lines.map((l) => `- ${l.text}${l.link ? ` ${l.link.url}` : ''}`), '']),
    ...(s.empty ? ['No new activity.', ''] : []),
    footer(s),
    ...(link ? ['', `Open the queue: ${link}`] : []),
  ].join('\n');
  const html = [
    `<p><strong>${htmlEsc(appName)} digest</strong> <span style="color:#71717a">${htmlEsc(period(s))}</span></p>`,
    ...secs.map(
      (sec) =>
        `<p style="margin:12px 0 4px"><strong>${htmlEsc(sec.title)}</strong></p><ul style="margin:0;padding-left:20px">${sec.lines
          .map((l) => `<li>${htmlEsc(l.text)}${l.link && /^https:\/\//.test(l.link.url) ? ` <a href="${htmlEsc(l.link.url)}">${l.link.label}</a>` : ''}</li>`)
          .join('')}</ul>`,
    ),
    ...(s.empty ? ['<p>No new activity.</p>'] : []),
    `<p style="color:#52525b">${htmlEsc(footer(s))}</p>`,
    ...(link && /^https:\/\//.test(link) ? [`<p><a href="${htmlEsc(link)}">Open the queue</a></p>`] : []),
  ].join('\n');
  return { format, subject, text, html, summary: s };
}

/** The period's digest, built and written in one call. */
export async function digest(store: ReportStore, opts: DigestOptions): Promise<DigestMessage> {
  return formatDigest(await buildDigest(store, opts), opts.format ?? 'markdown', opts);
}

/** Where a digest goes: like a broadcaster, but for one batched message. */
export interface DigestSender {
  name: string;
  /** The format it sends. */
  format: DigestFormat;
  send(message: DigestMessage): Promise<void>;
}

/** Posts the digest to a Slack incoming webhook. */
export function slackDigest(opts: { webhookUrl: string }): DigestSender {
  return {
    name: 'slack digest',
    format: 'slack',
    async send(m) {
      const res = await fetch(opts.webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: m.text }) });
      if (!res.ok) throw new Error(`${res.status} from Slack`);
    },
  };
}

/** Emails the digest with your provider's send (the same shape emailReporter takes). */
export function emailDigest(opts: { to: string; send: (message: EmailMessage) => Promise<void> }): DigestSender {
  return {
    name: 'email digest',
    format: 'email',
    async send(m) {
      await opts.send({ to: opts.to, subject: m.subject, html: m.html ?? '', text: m.text });
    },
  };
}
