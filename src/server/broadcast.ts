// Broadcasting: tell people or agents when something happens to a report (shipcue report
// 8c11cf21). A broadcaster is anything with a send(event); the handler calls every one that
// listens for that event. Built in: a signed JSON webhook (Zapier, n8n, an SMS or email
// bridge, an agent on a VPS, Mac mini or Tailscale address) and Slack.
import { createHmac } from 'node:crypto';
import type { Report } from '../core';

export type ShipcueEventType =
  | 'report.filed'
  | 'report.claimed'
  | 'report.assigned'
  | 'report.released'
  | 'report.review'
  | 'report.closed'
  | 'report.reopened'
  | 'report.video';
export const EVENT_TYPES: ShipcueEventType[] = [
  'report.filed',
  'report.claimed',
  'report.assigned',
  'report.released',
  'report.review',
  'report.closed',
  'report.reopened',
  'report.video',
];

export interface ShipcueEvent {
  type: ShipcueEventType;
  /** When it happened, ISO time. */
  at: string;
  report: Report;
}

export interface Broadcaster {
  /** For logs when a send fails, e.g. "slack" or "mac-mini". */
  name: string;
  /** The events it wants; all of them when left out. */
  events?: ShipcueEventType[];
  send(event: ShipcueEvent): Promise<void>;
}

/** One line a person can read: "Bug filed (high): The heading disappears on Enter". */
export function describeEvent(e: ShipcueEvent): string {
  const r = e.report;
  const kind = r.type === 'bug' ? 'Bug' : r.type === 'feature' ? 'Feature request' : 'Agent task';
  const what = r.description.length > 140 ? `${r.description.slice(0, 137)}...` : r.description;
  switch (e.type) {
    case 'report.filed':
      return `${kind} filed (${r.priority}): ${what}`;
    case 'report.claimed':
      return `${r.claimedBy ?? 'An agent'} took: ${what}`;
    case 'report.assigned':
      return r.claimedBy ? `Assigned to ${r.claimedBy}: ${what}` : `Unassigned: ${what}`;
    case 'report.released':
      return `Back in the queue: ${what}`;
    case 'report.review':
      return `In review${r.prUrl ? ` (${r.prUrl})` : ''}: ${what}`;
    case 'report.reopened':
      return `Reopened: ${what}`;
    case 'report.closed':
      return r.status === 'fixed' ? `Fixed: ${r.resolution ?? what}` : `Won't fix: ${what}${r.resolution ? ` (${r.resolution})` : ''}`;
    case 'report.video':
      return `Video added to: ${what}`;
  }
}

/** Signs a body the way webhook() does, so a receiver can check it came from shipcue. */
export function signBody(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

export interface WebhookOptions {
  url: string;
  /** Adds x-shipcue-signature: sha256=<hmac of the body>. Check it with signBody. */
  secret?: string;
  events?: ShipcueEventType[];
  name?: string;
  headers?: Record<string, string>;
}

/** POSTs { type, at, report, text } as JSON. */
export function webhook(opts: WebhookOptions): Broadcaster {
  return {
    name: opts.name ?? `webhook ${new URL(opts.url).host}`,
    events: opts.events,
    async send(event) {
      const body = JSON.stringify({ ...event, text: describeEvent(event) });
      const res = await fetch(opts.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-shipcue-event': event.type,
          ...(opts.secret ? { 'x-shipcue-signature': signBody(opts.secret, body) } : {}),
          ...opts.headers,
        },
        body,
      });
      if (!res.ok) throw new Error(`${res.status} from ${new URL(opts.url).host}`);
    },
  };
}

export interface SlackOptions {
  /** A Slack incoming webhook URL. */
  webhookUrl: string;
  events?: ShipcueEventType[];
  /** Where the queue can be seen, linked after the line, e.g. https://app.example.com/reports */
  link?: string;
}

/** A short line in a Slack channel. Never sends diagnostics or who filed it. */
export function slack(opts: SlackOptions): Broadcaster {
  return {
    name: 'slack',
    events: opts.events ?? ['report.filed', 'report.closed'],
    async send(event) {
      const text = describeEvent(event) + (opts.link ? ` <${opts.link}|Open>` : '');
      const res = await fetch(opts.webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
      if (!res.ok) throw new Error(`${res.status} from Slack`);
    },
  };
}

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface EmailReporterOptions {
  /** Sends one email: your provider (InsForge emails, Resend, SES…). Throw on failure. */
  send: (message: EmailMessage) => Promise<void>;
  /** Your app's name, in the subject and the opening line. */
  appName: string;
  /** Where people can see the changelog, linked in the email. */
  link?: string;
  /** Where reporters see all their own reports (the reporter portal, shipcue report 3d0d7995), linked in the email. */
  mineLink?: string;
  /**
   * Only email reporters you know are real: true when getReporter returns a signed-in user's
   * own email. Never pass reporter text a browser could make up, or anyone could send mail
   * through you. Defaults to every reporter that looks like an email.
   */
  trust?: (reporter: string, report: Report) => boolean;
}

const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Tells the person who filed a report when it is fixed, with the fix in one line. */
export function emailReporter(opts: EmailReporterOptions): Broadcaster {
  return {
    name: 'email reporter',
    events: ['report.closed'],
    async send(event) {
      const r = event.report;
      if (r.status !== 'fixed' || !r.reporter || !EMAIL.test(r.reporter)) return;
      if (opts.trust && !opts.trust(r.reporter, r)) return;
      const asked = (r.description.trim().split('\n')[0] ?? '').slice(0, 140);
      const fix = r.resolution?.trim() || 'It is fixed.';
      const subject = `Fixed: ${asked.length > 70 ? `${asked.slice(0, 67)}...` : asked}`;
      const text = [`What you reported to ${opts.appName} is fixed.`, '', `You asked: ${asked}`, `What changed: ${fix}`, ...(r.prUrl ? [`The change: ${r.prUrl}`] : []), ...(opts.link || opts.mineLink ? [''] : []), ...(opts.link ? [`See everything that changed: ${opts.link}`] : []), ...(opts.mineLink ? [`See all your reports: ${opts.mineLink}`] : [])].join('\n');
      const html = [
        `<p>What you reported to ${esc(opts.appName)} is fixed.</p>`,
        `<p style="color:#52525b">You asked: ${esc(asked)}</p>`,
        `<p><strong>What changed:</strong> ${esc(fix)}</p>`,
        ...(r.prUrl && /^https:\/\//.test(r.prUrl) ? [`<p><a href="${esc(r.prUrl)}">See the change</a></p>`] : []),
        ...(opts.link ? [`<p><a href="${esc(opts.link)}">Everything that changed</a></p>`] : []),
        ...(opts.mineLink ? [`<p><a href="${esc(opts.mineLink)}">All your reports</a></p>`] : []),
        '<p style="color:#a1a1aa;font-size:12px">Sent because you filed this report. Thanks for telling us.</p>',
      ].join('\n');
      await opts.send({ to: r.reporter, subject, html, text });
    },
  };
}

/**
 * Sends one event to every broadcaster that wants it, side by side, each given up after
 * timeoutMs. A failing broadcaster is logged and never fails the request.
 */
export async function broadcast(broadcasters: Broadcaster[] | undefined, event: ShipcueEvent, timeoutMs = 4000): Promise<void> {
  const wanted = (broadcasters ?? []).filter((b) => !b.events || b.events.includes(event.type));
  if (!wanted.length) return;
  await Promise.all(
    wanted.map(async (b) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          b.send(event),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
          }),
        ]);
      } catch (err) {
        console.error(`shipcue: broadcaster ${b.name} failed on ${event.type}:`, err instanceof Error ? err.message : err);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }),
  );
}
