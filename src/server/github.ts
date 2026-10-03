// Close the loop with GitHub (shipcue report 919f5ca2): a repository webhook for pull requests.
// A PR whose title, body or branch names a report (full id or its first 8 characters) moves it
// to In review with the PR link; merging it closes it as fixed, or, with liveCheck, once the
// app's version URL serves the merge commit. No GitHub App, no OAuth, no issue sync.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Claimant, Report } from '../core';
import type { ReportStore } from './store';

export interface GitHubOptions {
  /** The webhook's secret, as set in the repository's Settings → Webhooks. */
  secret: string;
  /**
   * Close merged reports only once production serves the merge: until then they stay In review.
   * Checked lazily (board, CueLog and agent reads, at most once per everyMs) or when your cron
   * calls handler.checkLive(); shipcue runs no timers of its own.
   */
  liveCheck?: {
    /** A URL on your production app that shows the deployed commit, e.g. /api/version. */
    url: string;
    /** Whether the page shows this merge. By default: the body contains the sha's first 7 characters. */
    match?: (body: string, sha: string) => boolean;
    /** At most one lazy check per this many ms (per server instance). 60 s by default. */
    everyMs?: number;
    /** Give up on the URL after this long. 5 s by default. */
    timeoutMs?: number;
    fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  };
}

/** True when `signature` (X-Hub-Signature-256) is the HMAC-SHA256 of the exact body with the secret. */
export function verifyGitHubSignature(secret: string, body: string, signature: string | null): boolean {
  if (!signature?.startsWith('sha256=')) return false;
  const given = Buffer.from(signature.slice(7), 'hex');
  const expected = createHmac('sha256', secret).update(body).digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const FULL_ID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const PREFIX = /(?<![0-9a-z])[0-9a-f]{8}(?![0-9a-z])/gi;

/** Report ids named in some text: full ids, and 8-character prefixes (a full id's prefix included). */
export function reportIdsIn(text: string): { full: string[]; prefixes: string[] } {
  const lower = text.toLowerCase();
  const full = [...new Set(lower.match(FULL_ID) ?? [])];
  const prefixes = [...new Set(lower.match(PREFIX) ?? [])];
  return { full, prefixes };
}

// While liveCheck waits, the report's resolution holds the merge, so no new column is needed.
const PENDING = /^Merged in #(\d+) \(([0-9a-f]{40})\), waiting to go live$/;
const pendingLine = (n: number, sha: string) => `Merged in #${n} (${sha}), waiting to go live`;

interface PullRequestEvent {
  action?: string;
  sender?: { login?: string };
  pull_request?: {
    number?: number;
    html_url?: string;
    title?: string | null;
    body?: string | null;
    head?: { ref?: string };
    merged?: boolean;
    merge_commit_sha?: string | null;
  };
}

export interface GitHubMove {
  id: string;
  status: Report['status'];
}

/** The webhook and the live check for one store. `emit` tells the broadcasters. */
export function githubLoop(store: ReportStore, opts: GitHubOptions, emit: (type: 'report.review' | 'report.closed' | 'report.released', r: Report | null) => Promise<void>) {
  const live = opts.liveCheck;
  const robot = (login?: string): Claimant => ({ kind: 'agent', id: 'github', name: login ? `github (@${login})` : 'github' });

  /** The reports in this store a PR names; an ambiguous prefix names none. */
  async function named(pr: NonNullable<PullRequestEvent['pull_request']>): Promise<Report[]> {
    const { full, prefixes } = reportIdsIn([pr.title, pr.body, pr.head?.ref].filter(Boolean).join('\n'));
    if (!full.length && !prefixes.length) return [];
    const found = new Map<string, Report>();
    for (const id of full) {
      const r = await store.get(id);
      if (r) found.set(r.id, r);
    }
    const rest = prefixes.filter((p) => ![...found.keys()].some((id) => id.startsWith(p)));
    if (rest.length) {
      const all = await store.list();
      for (const p of rest) {
        const hits = all.filter((r) => r.id.toLowerCase().startsWith(p));
        if (hits.length === 1) found.set(hits[0]!.id, hits[0]!);
      }
    }
    return [...found.values()];
  }

  let lastCheck = 0;

  async function webhook(req: Request): Promise<Response> {
    const raw = await req.text();
    if (!verifyGitHubSignature(opts.secret, raw, req.headers.get('x-hub-signature-256'))) return reply({ error: 'Bad signature' }, 401);
    const event = req.headers.get('x-github-event');
    if (event === 'ping') return reply({ ok: true });
    if (event !== 'pull_request') return reply({ ignored: event }, 202);
    let payload: PullRequestEvent;
    try {
      payload = JSON.parse(raw) as PullRequestEvent;
    } catch {
      return reply({ error: 'Send JSON (Content type: application/json).' }, 400);
    }
    const pr = payload.pull_request;
    const prUrl = pr?.html_url;
    if (!pr || typeof prUrl !== 'string' || !/^https:\/\/\S+$/.test(prUrl) || typeof pr.number !== 'number') return reply({ error: 'Not a pull request event.' }, 400);
    const by = robot(payload.sender?.login);
    const moved: GitHubMove[] = [];
    const note = (r: Report | null) => r && moved.push({ id: r.id, status: r.status });
    const action = payload.action ?? '';

    for (const r of await named(pr)) {
      if (['opened', 'reopened', 'edited', 'synchronize', 'ready_for_review'].includes(action)) {
        if (!store.review || !['open', 'claimed'].includes(r.status)) continue;
        const next = await store.review(r.id, prUrl, { by });
        await emit('report.review', next);
        note(next);
      } else if (action === 'closed' && pr.merged) {
        if (r.status === 'fixed' || r.status === 'wontfix') continue;
        const sha = pr.merge_commit_sha ?? '';
        if (live && store.edit && /^[0-9a-f]{40}$/.test(sha)) {
          // Waits In review until production serves the merge.
          if (r.status !== 'in_review' && store.review) await emit('report.review', await store.review(r.id, prUrl, { by }));
          note(await store.edit(r.id, { resolution: pendingLine(pr.number, sha) }, by));
          // The next read on this instance checks at once.
          lastCheck = 0;
        } else {
          const next = await store.close(r.id, 'fixed', `Merged in #${pr.number}`, { by, prUrl });
          await emit('report.closed', next);
          note(next);
        }
      } else if (action === 'closed') {
        // Closed without merging: reports in review under this PR go back to the queue.
        if (r.status !== 'in_review' || r.prUrl !== prUrl) continue;
        const next = await store.release(r.id, { by });
        await emit('report.released', next);
        note(next);
      }
    }
    return reply({ ok: true, moved });
  }

  /** Closes every merged report production now serves. Returns the reports it closed. */
  async function checkLive(): Promise<Report[]> {
    if (!live) return [];
    lastCheck = Date.now();
    const waiting = (await store.list({ status: 'in_review' })).flatMap((r) => {
      const m = PENDING.exec(r.resolution ?? '');
      return m ? [{ r, n: m[1]!, sha: m[2]! }] : [];
    });
    if (!waiting.length) return [];
    let body: string;
    try {
      const res = await (live.fetch ?? fetch)(live.url, { signal: AbortSignal.timeout(live.timeoutMs ?? 5000), headers: { 'cache-control': 'no-cache' } });
      if (!res.ok) return [];
      body = await res.text();
    } catch (err) {
      console.error('shipcue: liveCheck failed', err);
      return [];
    }
    const match = live.match ?? ((text: string, sha: string) => text.includes(sha.slice(0, 7)));
    const closed: Report[] = [];
    for (const { r, n, sha } of waiting) {
      if (!match(body, sha)) continue;
      const next = await store.close(r.id, 'fixed', `Merged in #${n}, live in ${sha.slice(0, 7)}`, { by: robot(), prUrl: r.prUrl });
      await emit('report.closed', next);
      if (next) closed.push(next);
    }
    return closed;
  }

  /** The lazy check on reads: at most once per everyMs. */
  async function maybeCheckLive(): Promise<void> {
    if (!live || Date.now() - lastCheck < (live.everyMs ?? 60_000)) return;
    try {
      await checkLive();
    } catch (err) {
      console.error('shipcue: liveCheck failed', err);
    }
  }

  return { webhook, checkLive, maybeCheckLive };
}

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
