import { createHmac, timingSafeEqual } from 'node:crypto';
import { altFragment, BLOCKED_FILE_TYPES, MAX_RESOLUTION, PRIORITIES, formatBytes, resolveConfig, toAgentPrompt, toBoardItem, validateEdit, validateReport, videoExtension, videoType, withShotAlt, type Board, type Capabilities, type Claimant, type ReportType, type ShipcueConfig, type Report } from '../core';
import type { ReportStore } from './store';
import { broadcast, type Broadcaster, type ShipcueEventType } from './broadcast';
import { findGitHubLink, publicGitHubLinks } from './links';
import { DIGEST_PERIOD_MS, digest as buildDigestMessage, type DigestFormat, type DigestPeriod, type DigestSender } from './digest';

const IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export interface HandlerOptions {
  store: ReportStore;
  config?: ShipcueConfig;
  /** Where the handler is mounted, e.g. "/api/shipcue". */
  basePath?: string;
  /** Who is filing: an email, user id or name from your session. Null when signed out. */
  getReporter?: (req: Request) => Promise<string | null>;
  /** Refuse reports from signed-out people. */
  requireReporter?: boolean;
  /**
   * Take this many reports from each signed-out person, then ask them to sign in (they can still
   * send anonymously once signed in). People are told apart by clientKey; the store keeps only a
   * keyed hash. Needs the client_key column ("Upgrading from 0.13" in sql/schema.sql).
   */
  anonymousLimit?: number;
  /** Where "Sign in" goes when anonymousLimit is reached. */
  signInUrl?: string | ((req: Request) => string);
  /** Tells signed-out people apart. By default a keyed hash of their IP address (x-forwarded-for, x-real-ip). */
  clientKey?: (req: Request) => string | null | Promise<string | null>;
  /** The key for that hash. Defaults to agentToken. */
  clientKeySecret?: string;
  /** Upload a screenshot and return its URL. Without it, screenshots are kept as data URLs. */
  saveScreenshot?: (file: File, key: string) => Promise<string>;
  /**
   * Upload a report's video and return its URL. Turns on POST {base}/reports/:id/video.
   * On hosts that cap request bodies (Vercel: 4.5 MB), upload from the browser
   * instead with the button's uploadVideo prop.
   */
  saveVideo?: (file: File, key: string) => Promise<string>;
  /** Runs after a report is saved: email, Slack, a task board. A failure here never fails the report. */
  onReport?: (report: Report) => Promise<void>;
  /** Bearer token for the agent API, shared by every agent. Leave unset (and agents unset) to switch the agent API off. */
  agentToken?: string;
  /**
   * Each agent with its own token: return who the token belongs to, or null. Its claims carry
   * its id and name (not whatever it sends), and it can only release or close what it holds.
   * Works alongside agentToken.
   */
  agents?: (token: string, req: Request) => Promise<AgentIdentity | null>;
  /**
   * Seconds an agent's claim lasts unless it checks in (heartbeat, or any call on the report);
   * an expired claim goes back to the queue. Leave unset for claims that never run out. An
   * agent's own leaseSeconds wins.
   */
  leaseSeconds?: number;
  /**
   * The team API behind the CueLog table: GET/POST {base}/team/... for signed-in members to
   * see every report in full and claim, assign, release, close, reopen and reprioritise.
   * Viewers can only read.
   */
  team?: {
    /** The signed-in member from the request's session, or null. */
    getMember: (req: Request) => Promise<TeamMember | null>;
    /** The people and agents a report can be assigned to. */
    claimants?: (req: Request) => Promise<Claimant[]>;
  };
  /**
   * The public board: GET {base}/board returns the queue (open and claimed) and the
   * changelog (fixed, with each fix's resolution), for <ShipcueBoard />. Off by default.
   * Items carry no reporter, page, diagnostics or attachments. Pass a function to decide
   * per request, e.g. signed-in people only.
   */
  board?: boolean | ((req: Request) => Promise<boolean> | boolean);
  /**
   * Show each report's screenshots on the board too. Off by default: screenshots can show
   * private things, so turn it on only where everyone who can see the board may see them.
   * Data-URL screenshots are served from GET {base}/board/screenshot/:id/:n, as images only.
   */
  boardScreenshots?: boolean;
  /**
   * Link each fix on the board: a report's PR, or the first GitHub link in its resolution. By
   * default only links into public GitHub repositories show (checked once per repository); true
   * shows every link, false none, or decide per link. Admins (boardAdmin) always see them.
   */
  boardLinks?: boolean | ((url: string, req: Request) => boolean | Promise<boolean>);
  /** Who sees every link on the board, e.g. the project's team. */
  boardAdmin?: (req: Request) => boolean | Promise<boolean>;
  /**
   * Take a video by URL: the button uploads it straight to your storage (say a presigned or
   * Vercel Blob client upload, past the 4.5 MB request limit), then posts { url } to
   * {base}/reports/:id/video. Return true only for URLs in your own storage for that report.
   */
  acceptVideoUrl?: (url: string, reportId: string) => boolean | Promise<boolean>;
  /**
   * The biggest request your host lets through. Videos posted to the handler (saveVideo)
   * must fit in one request, so the button caps them at this. 4.4 MB by default, under
   * Vercel's 4.5 MB; raise it on hosts without that limit.
   */
  maxRequestBytes?: number;
  /**
   * Who hears about reports: people (Slack, email, a text bridge) or agents (a webhook on a
   * VPS, Mac mini or Tailscale address). Each gets the events it lists, after the change is
   * saved; one that fails or is slow is logged and never fails the request. See webhook(),
   * slack() and the shipcue-listen command for agents that would rather poll.
   */
  broadcasters?: Broadcaster[];
  /**
   * Take reports from other sites: the origins allowed to call this handler from a browser
   * (e.g. ['https://app.example.com']), or a function deciding per origin. For a hosted queue
   * like shipcue Cloud; off by default, so a self-hosted handler answers its own site only.
   */
  cors?: string[] | ((origin: string, req: Request) => boolean | Promise<boolean>);
  /**
   * The activity digest (shipcue report 5f4d339b): POST {base}/digest, with the agent token,
   * builds one summary of the last period (filed, fixed with their fix lines and PRs, reopened,
   * claims stuck past their lease, how many are still open, the oldest waiting) and sends it
   * with `send` (slackDigest, emailDigest or your own), or returns it as Markdown. Call it from
   * a cron (Vercel Cron, GitHub Actions, launchd) every hour or day. Off unless given.
   */
  digest?: DigestHandlerOptions;
}

export interface DigestHandlerOptions {
  /** The period one call covers when it names no since. 'day' by default. */
  every?: DigestPeriod;
  /** Where the digest goes. Without it the route returns the digest (Markdown unless asked otherwise). */
  send?: DigestSender;
  /** Your app's name in the heading. */
  appName?: string;
  /** Where the queue can be seen, linked at the end. */
  link?: string;
  /** Send even when nothing happened in the period. Off by default. */
  sendEmpty?: boolean;
}

/** Who an agent token belongs to (see HandlerOptions.agents). */
export interface AgentIdentity {
  id: string;
  name: string;
  /** Take unassigned open reports too (pull mode). True by default. */
  pull?: boolean;
  /** Only these report types; all when left out. */
  types?: ReportType[];
  leaseSeconds?: number;
}

export interface TeamMember {
  /** Stable id, e.g. an email: claims are stored under it. */
  id: string;
  name: string;
  role: 'owner' | 'member' | 'viewer';
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fail = (error: string, status = 400) => json({ error }, status);

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A screenshot the board may show: an https/relative link, or the board's own route. */
// The #alt= fragment is not part of the file name.
const isImageLink = (u: string) => u.startsWith('/') || (u.startsWith('https://') && !/\.(?!png|jpe?g|webp|gif)[a-z0-9]{2,5}(?:[?#]|$)/i.test(u.replace(/#.*$/, '')));

async function toDataUrl(file: File, withName = false): Promise<string> {
  const base64 = Buffer.from(await file.arrayBuffer()).toString('base64');
  const name = withName && file.name ? `;name=${encodeURIComponent(file.name)}` : '';
  return `data:${file.type || 'application/octet-stream'}${name};base64,${base64}`;
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * One fetch-style handler for both sides of the queue:
 *
 *   POST {base}/reports                 the button files a report (multipart form)
 *   GET  {base}/capabilities            what this handler takes (videos, other files), for the button
 *   POST {base}/reports/:id/video       the button attaches a video (multipart "video", or JSON { url })
 *   GET  {base}/reports?status=open     agent: the queue, most urgent first
 *   GET  {base}/reports/:id             agent: one report plus a ready-made prompt
 *   POST {base}/reports/next/claim      agent: take the most urgent open report
 *   POST {base}/reports/:id/claim       agent: take a specific report
 *   POST {base}/reports/:id/release     agent: give it back
 *   POST {base}/reports/:id/close       agent: { status: fixed|wontfix, resolution, prUrl? }
 *   POST {base}/reports/:id/heartbeat   agent: renew its lease
 *   POST {base}/reports/:id/review      agent: { prUrl }: a PR is up, the report is in review
 *   GET  {base}/reports/:id/events      agent: the report's history
 *   POST {base}/reports/:id/note        agent: { text }: a note on the report's history
 *   GET  {base}/reports?mine=1          agent: what it holds or has queued
 *   GET|POST {base}/team/...            the CueLog table for signed-in members (see the team option)
 *
 * In Next.js: app/api/shipcue/[...path]/route.ts → export { handler as GET, handler as POST }.
 */
export function createShipcueHandler(opts: HandlerOptions): (req: Request) => Promise<Response> {
  const config = opts.config ?? resolveConfig();
  const base = (opts.basePath ?? '/api/shipcue').replace(/\/$/, '');
  const { store } = opts;
  const emit = (type: ShipcueEventType, report: Report | null) =>
    report ? broadcast(opts.broadcasters, { type, at: new Date().toISOString(), report }) : Promise.resolve();

  const ipKey = (req: Request) => {
    const ip = (req.headers.get('x-forwarded-for')?.split(',')[0] ?? req.headers.get('x-real-ip') ?? '').trim();
    if (!ip) return null;
    return createHmac('sha256', opts.clientKeySecret ?? opts.agentToken ?? 'shipcue').update(ip).digest('hex').slice(0, 32);
  };
  const signInFor = (req: Request) => (typeof opts.signInUrl === 'function' ? opts.signInUrl(req) : opts.signInUrl);

  async function fileReport(req: Request): Promise<Response> {
    const reporter = opts.getReporter ? await opts.getReporter(req) : null;
    if (opts.requireReporter && !reporter) return fail('Sign in to send a report.', 401);
    // A few reports without signing in, then sign in (shipcue report dce33fd0).
    let clientKey: string | null = null;
    if (!reporter && opts.anonymousLimit !== undefined && store.countFromClient) {
      clientKey = opts.clientKey ? await opts.clientKey(req) : ipKey(req);
      if (clientKey && (await store.countFromClient(clientKey)) >= opts.anonymousLimit) {
        const n = opts.anonymousLimit;
        return json(
          {
            error: `You have sent ${n} report${n === 1 ? '' : 's'} without signing in. Sign in to send more; you can still send them anonymously.`,
            signIn: signInFor(req) ?? null,
          },
          401,
        );
      }
    }

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return fail('Send the report as a form.');
    }
    let diagnostics: unknown = {};
    const rawDiagnostics = form.get('diagnostics');
    if (typeof rawDiagnostics === 'string' && rawDiagnostics) {
      try {
        diagnostics = JSON.parse(rawDiagnostics);
      } catch {
        diagnostics = {};
      }
    }
    const checked = validateReport(
      {
        type: form.get('type') ?? undefined,
        priority: form.get('priority') ?? undefined,
        area: form.get('area') ?? undefined,
        description: form.get('description') ?? '',
        pageUrl: form.get('pageUrl') ?? '',
        userAgent: form.get('userAgent') ?? '',
        context: form.get('context') ?? '',
        diagnostics,
      },
      config,
    );
    if (!checked.ok) return fail(checked.error);

    const shots = form.getAll('screenshot').filter((f): f is File => f instanceof File && f.size > 0);
    // Other files (allowFiles): kept after the screenshots, under the same limits.
    const others = form.getAll('file').filter((f): f is File => f instanceof File && f.size > 0);
    if (others.length && !config.allowFiles) return fail('This app takes screenshots and videos only.');
    const files = [...shots, ...others];
    if (files.length > config.maxScreenshots) return fail(`Up to ${config.maxScreenshots} screenshots and files.`);
    for (const f of shots) {
      if (!IMAGE_TYPES[f.type]) return fail('Screenshots must be PNG, JPG, WebP or GIF.');
    }
    for (const f of others) {
      if (BLOCKED_FILE_TYPES.includes(f.type.split(';')[0]!.trim().toLowerCase()) || /\.(html?|svg|js|exe)$/i.test(f.name)) {
        return fail(`${f.name || 'That file'} cannot be attached.`);
      }
    }
    for (const f of files) {
      if (f.size > config.maxScreenshotBytes) {
        return fail(`Each screenshot or file must be under ${Math.round(config.maxScreenshotBytes / 1024 / 1024)} MB.`);
      }
    }
    const total = files.reduce((n, f) => n + f.size, 0);
    if (total > config.maxTotalScreenshotBytes) {
      return fail(`The screenshots add up to more than ${formatBytes(config.maxTotalScreenshotBytes)}. Send fewer, or send the rest in another report.`);
    }

    // The key folder groups one report's screenshots; it is not the report id.
    const batch = crypto.randomUUID();
    const screenshots: string[] = [];
    // Alt text per screenshot, in the same order (shipcue report 58b727d9).
    const alts = form.getAll('screenshotAlt').map((a) => (typeof a === 'string' ? a.slice(0, config.maxAltText) : ''));
    for (const [i, f] of files.entries()) {
      const key = `${batch}/${i + 1}.${IMAGE_TYPES[f.type]}`;
      const src = opts.saveScreenshot ? await opts.saveScreenshot(f, key) : await toDataUrl(f, !IMAGE_TYPES[f.type]);
      screenshots.push(i < shots.length && alts[i] ? withShotAlt(src, alts[i]!) : src);
    }

    // Signed in, they may still leave their name off it.
    const anonymous = !!reporter && opts.anonymousLimit !== undefined && form.get('anonymous') === '1';
    const report = await store.create({ ...checked.value, reporter: anonymous ? null : reporter, screenshots, ...(clientKey ? { clientKey } : {}) });
    if (opts.onReport) {
      try {
        await opts.onReport(report);
      } catch (err) {
        console.error('shipcue: onReport failed', err);
      }
    }
    await emit('report.filed', report);
    return json({ id: report.id }, 201);
  }

  // A video can be attached by whoever filed the report, once, within this window.
  const VIDEO_WINDOW_MS = 30 * 60 * 1000;

  async function attachVideo(req: Request, id: string): Promise<Response> {
    if (!opts.saveVideo && !opts.acceptVideoUrl) return fail('This app does not take videos.', 404);
    const report = await store.get(id);
    if (!report) return fail('No such report', 404);
    const reporter = opts.getReporter ? await opts.getReporter(req) : null;
    if (report.reporter !== null && report.reporter !== reporter) return fail('Not your report.', 403);
    if (Date.now() - Date.parse(report.createdAt) > VIDEO_WINDOW_MS) return fail('Too late to add a video to this report.', 403);
    if (report.video) return fail('This report already has a video.', 409);

    if ((req.headers.get('content-type') ?? '').includes('application/json')) {
      if (!opts.acceptVideoUrl) return fail('Send the video as a form.');
      const { url } = await readJson(req);
      if (typeof url !== 'string' || !url.startsWith('https://') || !(await opts.acceptVideoUrl(url, id))) {
        return fail('That video link is not one this app stored.', 400);
      }
      const saved = await store.attachVideo(id, url);
      await emit('report.video', saved);
      return saved ? json({ report: saved }) : fail('This report already has a video.', 409);
    }
    if (!opts.saveVideo) return fail('This app takes videos by link only.', 400);

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return fail('Send the video as a form.');
    }
    const file = form.get('video');
    if (!(file instanceof File) || file.size === 0) return fail('Attach a video.');
    const type = videoType(file.type);
    if (!type) return fail('Attach a WebM, MP4 or MOV video.');
    if (file.size > config.maxVideoBytes) return fail(`Videos can be up to ${formatBytes(config.maxVideoBytes)}.`);

    const url = await opts.saveVideo!(file, `${id}/video.${videoExtension(type)}`);
    const saved = await store.attachVideo(id, url);
    await emit('report.video', saved);
    return saved ? json({ report: saved }) : fail('This report already has a video.', 409);
  }

  const withPrompt = (r: Report) => ({ report: r, prompt: toAgentPrompt(r, config) });

  /** Releases claims whose lease ran out, and tells the broadcasters. */
  async function expireLeases() {
    if (!store.expire) return;
    for (const r of await store.expire()) await emit('report.released', r);
  }

  /** A note's text, trimmed and within config.maxNote, or an error (shipcue report 3d2dded6). */
  const noteText = (v: unknown): { text: string } | { error: string } => {
    const text = typeof v === 'string' ? v.trim() : '';
    if (!text) return { error: 'Write the note.' };
    if (text.length > config.maxNote) return { error: `Notes can be up to ${config.maxNote} characters.` };
    return { text };
  };

  const isPrUrl = (v: unknown): v is string => typeof v === 'string' && v.length <= 500 && /^https?:\/\/[^\s]+$/i.test(v);

  /** 409 naming the holder when there is one, else 404. */
  async function lost(id: string, verb = 'Someone else has it'): Promise<Response> {
    const r = await store.get(id);
    if (!r) return fail('No such report', 404);
    return fail(r.claimedBy ? `${r.claimedBy} has it now.` : verb, 409);
  }

  /** The bearer token's agent, the shared token's 'shared', or null. */
  async function agentAuth(req: Request): Promise<AgentIdentity | 'shared' | null> {
    const auth = req.headers.get('authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const identity = token && opts.agents ? await opts.agents(token, req) : null;
    if (identity) return identity;
    return token && opts.agentToken && sameToken(token, opts.agentToken) ? 'shared' : null;
  }

  /** POST {base}/digest: the last period's digest, sent or returned (shipcue report 5f4d339b). */
  async function digestRoute(req: Request): Promise<Response> {
    const d = opts.digest;
    if (!d || (!opts.agentToken && !opts.agents)) return fail('Not found', 404);
    if (!(await agentAuth(req))) return fail('Unauthorized', 401);
    const body = await readJson(req);
    const time = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v) : null);
    const every: DigestPeriod = body.every === 'hour' || body.every === 'day' ? body.every : (d.every ?? 'day');
    if ((body.since != null && !time(body.since)) || (body.until != null && !time(body.until))) return fail('since and until are ISO times.');
    const until = time(body.until) ?? new Date();
    const since = time(body.since) ?? new Date(until.getTime() - DIGEST_PERIOD_MS[every]);
    if (since >= until) return fail('since must be before until.');
    const asked = (['slack', 'email', 'markdown'] as const).find((f) => f === body.format);
    const format: DigestFormat = d.send ? d.send.format : (asked ?? 'markdown');
    const message = await buildDigestMessage(store, { since, until, format, appName: d.appName, link: d.link });
    const out = { subject: message.subject, text: message.text, format, empty: message.summary.empty, summary: message.summary };
    if (!d.send || (message.summary.empty && !d.sendEmpty)) return json({ ...out, sent: false });
    await d.send.send(message);
    return json({ ...out, sent: true });
  }

  async function agentApi(req: Request, parts: string[]): Promise<Response> {
    if (!opts.agentToken && !opts.agents) return fail('Not found', 404);
    const who = await agentAuth(req);
    if (!who) return fail('Unauthorized', 401);
    const identity = who === 'shared' ? null : who;

    const [id, action] = parts;
    const body = req.method === 'POST' ? await readJson(req) : {};
    // A shared-token agent says who it is; an agent with its own token is who its token says.
    const said = String(body.agent ?? new URL(req.url).searchParams.get('agent') ?? 'agent').slice(0, 100);
    const me: Claimant = identity ? { kind: 'agent', id: identity.id, name: identity.name } : { kind: 'agent', id: said, name: said };
    const holder = identity ? identity.id : undefined;
    const by = identity ? me : null;
    const leaseSeconds = identity?.leaseSeconds ?? opts.leaseSeconds;

    if (req.method === 'GET' && !id) {
      await expireLeases();
      const params = new URL(req.url).searchParams;
      const filter = (['open', 'claimed', 'in_review', 'fixed', 'wontfix'] as const).find((s) => s === params.get('status'));
      const mine = params.get('mine') === '1' ? me.id : undefined;
      return json({ reports: await store.list({ ...(filter ? { status: filter } : {}), ...(mine ? { claimant: mine } : {}) }) });
    }
    if (req.method === 'GET' && id && !action) {
      const r = await store.get(id);
      return r ? json(withPrompt(r)) : fail('No such report', 404);
    }
    if (req.method === 'GET' && id && action === 'events') {
      if (!(await store.get(id))) return fail('No such report', 404);
      return json({ events: store.events ? await store.events(id) : [] });
    }
    if (req.method !== 'POST' || !id || !action) return fail('Not found', 404);

    if (id === 'next' && action === 'claim') {
      await expireLeases();
      const r = await store.claimNext(me, { leaseSeconds, pull: identity?.pull, types: identity?.types });
      await emit('report.claimed', r);
      return r ? json(withPrompt(r)) : new Response(null, { status: 204 });
    }
    if (action === 'claim') {
      await expireLeases();
      if (identity?.types) {
        const r = await store.get(id);
        if (r && !identity.types.includes(r.type)) return fail(`This agent does not take ${r.type} reports.`, 403);
      }
      const r = await store.claim(id, me, { leaseSeconds });
      await emit('report.claimed', r);
      return r ? json(withPrompt(r)) : lost(id);
    }
    if (action === 'release') {
      const r = await store.release(id, { holder, by });
      await emit('report.released', r);
      return r ? json({ report: r }) : identity ? lost(id, 'Not claimed') : fail('Not claimed', 409);
    }
    if (action === 'heartbeat') {
      if (!store.heartbeat || leaseSeconds === undefined) {
        const r = await store.get(id);
        return r ? json({ report: r }) : fail('No such report', 404);
      }
      const r = await store.heartbeat(id, me.id, leaseSeconds);
      return r ? json({ report: r }) : lost(id, 'Not claimed');
    }
    if (action === 'review') {
      if (!store.review) return fail('Not found', 404);
      if (!isPrUrl(body.prUrl)) return fail('prUrl must be an http(s) link.');
      const r = await store.review(id, body.prUrl, { holder, by });
      await emit('report.review', r);
      return r ? json({ report: r }) : lost(id);
    }
    if (action === 'close') {
      if (body.status !== 'fixed' && body.status !== 'wontfix') return fail('status must be fixed or wontfix');
      if (body.prUrl != null && !isPrUrl(body.prUrl)) return fail('prUrl must be an http(s) link.');
      const resolution = body.resolution == null ? null : String(body.resolution).slice(0, MAX_RESOLUTION);
      const r = await store.close(id, body.status, resolution, { holder, by, prUrl: (body.prUrl as string | undefined) ?? null });
      await emit('report.closed', r);
      return r ? json({ report: r }) : identity ? lost(id) : fail('No such report', 404);
    }
    if (action === 'note') {
      // Any agent may note any report; it goes in the history under its name (shipcue report 3d2dded6).
      if (!store.note) return fail('Not found', 404);
      const n = noteText(body.text);
      if ('error' in n) return fail(n.error);
      const event = await store.note(id, n.text, me);
      return event ? json({ event }, 201) : fail('No such report', 404);
    }
    return fail('Not found', 404);
  }

  // Data-URL attachments become links on the team API, so the list stays small.
  const teamShots = (r: Report) => r.screenshots.map((src, n) => (src.startsWith('data:') ? `${base}/team/screenshot/${r.id}/${n}${altFragment(src)}` : src));
  const forTeam = (r: Report) => ({ ...r, screenshots: teamShots(r) });
  /** A row of the list: no diagnostics, which can be large; GET team/reports/:id has them. */
  const forTeamList = (r: Report) => {
    const { diagnostics: _, ...row } = forTeam(r);
    return row;
  };

  async function teamApi(req: Request, parts: string[]): Promise<Response> {
    if (!opts.team) return fail('Not found', 404);
    const member = await opts.team.getMember(req);
    if (!member) return fail('Sign in to see the CueLog.', 401);
    const me: Claimant = { kind: 'person', id: member.id, name: member.name };
    const claimants = () => (opts.team!.claimants ? opts.team!.claimants(req) : Promise.resolve([me]));
    const [section, id, action] = parts;

    // The areas come along so the CueLog's Edit can offer them without the app passing them again.
    if (req.method === 'GET' && section === 'me') return json({ member, claimants: await claimants(), areas: config.areas });
    if (req.method === 'GET' && section === 'version') {
      const version = store.version ? await store.version() : String((await store.list()).length);
      return new Response(JSON.stringify({ version }), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    }
    if (req.method === 'GET' && section === 'screenshot' && id && action && /^\d{1,2}$/.test(action)) {
      const r = await store.get(id);
      const m = /^data:([^;,]+)(?:;[^;,]+)*;base64,(.+)$/.exec(r?.screenshots[Number(action)] ?? '');
      if (!m) return fail('Not found', 404);
      const type = m[1] ?? 'application/octet-stream';
      const image = /^image\/(png|jpeg|webp|gif)$/.test(type);
      return new Response(Buffer.from(m[2] ?? '', 'base64'), {
        headers: {
          'content-type': image ? type : 'application/octet-stream',
          ...(image ? {} : { 'content-disposition': 'attachment' }),
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; sandbox",
          'cache-control': 'private, max-age=3600',
        },
      });
    }
    if (section !== 'reports') return fail('Not found', 404);
    if (req.method === 'GET' && !id) {
      await expireLeases();
      const status = (['open', 'claimed', 'in_review', 'fixed', 'wontfix'] as const).find((s) => s === new URL(req.url).searchParams.get('status'));
      return json({ reports: (await store.list(status ? { status } : {})).map(forTeamList) });
    }
    if (req.method === 'GET' && id && !action) {
      const r = await store.get(id);
      if (!r) return fail('No such report', 404);
      return json({ report: forTeam(r), prompt: toAgentPrompt(r, config), events: store.events ? await store.events(id) : [] });
    }
    if (req.method !== 'POST' || !id || !action) return fail('Not found', 404);
    if (member.role === 'viewer') return fail('Viewers can look but not change reports.', 403);
    const body = await readJson(req);

    switch (action) {
      case 'claim': {
        const r = await store.claim(id, me);
        await emit('report.claimed', r);
        return r ? json({ report: forTeam(r) }) : lost(id);
      }
      case 'assign': {
        if (!store.assign) return fail('Not found', 404);
        let to: Claimant | null = null;
        if (body.to != null) {
          const want = body.to as { kind?: unknown; id?: unknown };
          to = (await claimants()).find((c) => c.kind === want.kind && c.id === want.id) ?? null;
          if (!to) return fail('Pick someone from the list.');
        }
        const r = await store.assign(id, to, me);
        await emit('report.assigned', r);
        return r ? json({ report: forTeam(r) }) : fail('Only open or claimed reports can be assigned.', 409);
      }
      case 'release': {
        const r = await store.release(id, { by: me });
        await emit('report.released', r);
        return r ? json({ report: forTeam(r) }) : fail('Not claimed', 409);
      }
      case 'close': {
        if (body.status !== 'fixed' && body.status !== 'wontfix') return fail('status must be fixed or wontfix');
        if (body.prUrl != null && !isPrUrl(body.prUrl)) return fail('prUrl must be an http(s) link.');
        const resolution = body.resolution == null ? null : String(body.resolution).slice(0, MAX_RESOLUTION);
        const r = await store.close(id, body.status, resolution, { by: me, prUrl: (body.prUrl as string | undefined) ?? null });
        await emit('report.closed', r);
        return r ? json({ report: forTeam(r) }) : fail('No such report', 404);
      }
      case 'reopen': {
        if (!store.reopen) return fail('Not found', 404);
        const r = await store.reopen(id, me);
        await emit('report.reopened', r);
        return r ? json({ report: forTeam(r) }) : fail('Only closed or in-review reports can be reopened.', 409);
      }
      case 'review': {
        if (!store.review) return fail('Not found', 404);
        if (!isPrUrl(body.prUrl)) return fail('prUrl must be an http(s) link.');
        const r = await store.review(id, body.prUrl, { by: me });
        await emit('report.review', r);
        return r ? json({ report: forTeam(r) }) : fail('Only open or claimed reports can go to review.', 409);
      }
      case 'note': {
        if (!store.note) return fail('Not found', 404);
        const n = noteText(body.text);
        if ('error' in n) return fail(n.error);
        const event = await store.note(id, n.text, me);
        const r = event && (await store.get(id));
        return r ? json({ event, report: forTeam(r) }, 201) : fail('No such report', 404);
      }
      case 'edit': {
        // Rewrite the text, type, area or what-changed line (shipcue report 5c54da74).
        if (!store.edit) return fail('Not found', 404);
        const edit = validateEdit(body, config);
        if (!edit.ok) return fail(edit.error);
        const r = await store.edit(id, edit.value, me);
        return r ? json({ report: forTeam(r) }) : fail('No such report', 404);
      }
      case 'priority': {
        if (!store.setPriority) return fail('Not found', 404);
        const priority = PRIORITIES.find((x) => x === body.priority);
        if (!priority) return fail('Pick a priority.');
        const r = await store.setPriority(id, priority, me);
        return r ? json({ report: forTeam(r) }) : fail('No such report', 404);
      }
    }
    return fail('Not found', 404);
  }

  const BOARD_LIMIT = 200;
  const defaultLinks = publicGitHubLinks();

  async function board(req: Request): Promise<Response> {
    const allowed = typeof opts.board === 'function' ? await opts.board(req) : opts.board === true;
    if (!allowed) return fail('Not found', 404);
    const [open, claimed, inReview, fixed] = await Promise.all([
      store.list({ status: 'open' }),
      store.list({ status: 'claimed' }),
      store.list({ status: 'in_review' }),
      store.list({ status: 'fixed' }),
    ]);
    const admin = opts.boardAdmin ? await opts.boardAdmin(req) : false;
    const mayLink = async (url: string) => {
      if (admin || opts.boardLinks === true) return true;
      if (opts.boardLinks === false) return false;
      return (opts.boardLinks ?? defaultLinks)(url, req);
    };
    const item = async (r: Report) => {
      const base = toBoardItem(r, opts.boardScreenshots ? boardShots(r) : undefined);
      const url = r.prUrl ?? findGitHubLink(r.resolution);
      return url && (await mayLink(url)) ? { ...base, prUrl: url } : base;
    };
    const result: Board = {
      queue: await Promise.all([...inReview, ...claimed, ...open].slice(0, BOARD_LIMIT).map(item)),
      changelog: (await Promise.all(fixed.map(item))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, BOARD_LIMIT),
    };
    return new Response(JSON.stringify(result), {
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }

  // Stored URLs pass through; data URLs become short links, so the board stays small.
  const boardShots = (r: Report) =>
    r.screenshots
      .map((src, n) => (src.startsWith('data:') ? (/^data:image\/(png|jpeg|webp|gif)[;,]/.test(src) ? `${base}/board/screenshot/${r.id}/${n}${altFragment(src)}` : '') : src))
      .filter(isImageLink);

  async function boardScreenshot(req: Request, id: string, n: number): Promise<Response> {
    const allowed = typeof opts.board === 'function' ? await opts.board(req) : opts.board === true;
    if (!allowed || !opts.boardScreenshots) return fail('Not found', 404);
    const r = await store.get(id);
    // Only what the board lists: open, claimed, in review or fixed.
    if (!r || !['open', 'claimed', 'in_review', 'fixed'].includes(r.status)) return fail('Not found', 404);
    // Parameters (;alt=) may sit between the type and the data.
    const m = /^data:(image\/(?:png|jpeg|webp|gif))(?:;[^;,]+)*;base64,(.+)$/.exec(r.screenshots[n] ?? '');
    if (!m) return fail('Not found', 404);
    return new Response(Buffer.from(m[2] ?? '', 'base64'), {
      headers: {
        'content-type': m[1] ?? 'image/png',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'cache-control': 'public, max-age=3600',
      },
    });
  }

  const corsAllows = async (req: Request): Promise<string | null> => {
    const origin = req.headers.get('origin');
    if (!origin || !opts.cors) return null;
    const ok = typeof opts.cors === 'function' ? await opts.cors(origin, req) : opts.cors.includes(origin);
    return ok ? origin : null;
  };
  const withCors = (res: Response, origin: string) => {
    const headers = new Headers(res.headers);
    headers.set('access-control-allow-origin', origin);
    headers.append('vary', 'Origin');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };

  const route = async (req: Request): Promise<Response> => {
    const path = new URL(req.url).pathname;
    const shot = req.method === 'GET' ? new RegExp(`^${escapeRe(base)}/board/screenshot/([^/]+)/(\\d{1,2})$`).exec(path) : null;
    if (shot) {
      try {
        return await boardScreenshot(req, shot[1] ?? '', Number(shot[2]));
      } catch (err) {
        console.error('shipcue: board screenshot failed', err);
        return fail('Something went wrong. Please try again.', 500);
      }
    }
    if (req.method === 'GET' && path === `${base}/capabilities`) {
      const caps: Capabilities = {
        video: opts.saveVideo ? 'form' : opts.acceptVideoUrl ? 'url' : null,
        files: config.allowFiles,
        // A video posted to the handler has to fit in one request; one uploaded straight to storage does not.
        maxVideoBytes: opts.saveVideo ? Math.min(config.maxVideoBytes, opts.maxRequestBytes ?? Math.floor(4.4 * 1024 * 1024)) : config.maxVideoBytes,
        maxVideoSeconds: config.maxVideoSeconds,
        maxScreenshots: config.maxScreenshots,
        maxScreenshotBytes: config.maxScreenshotBytes,
        maxTotalScreenshotBytes: config.maxTotalScreenshotBytes,
        maxAltText: config.maxAltText,
        ...(opts.anonymousLimit !== undefined ? { signedIn: !!(opts.getReporter && (await opts.getReporter(req))), anonymous: true } : {}),
      };
      return new Response(JSON.stringify(caps), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    }
    if (req.method === 'GET' && path === `${base}/board/version`) {
      // A live board polls this every few seconds and re-reads /board only when it moves.
      try {
        const allowed = typeof opts.board === 'function' ? await opts.board(req) : opts.board === true;
        if (!allowed) return fail('Not found', 404);
        let version: string;
        if (store.version) version = await store.version();
        else {
          const all = await store.list();
          version = `${all.length}:${all.reduce((m, r) => ((r.updatedAt ?? r.createdAt) > m ? (r.updatedAt ?? r.createdAt) : m), '')}`;
        }
        return new Response(JSON.stringify({ version }), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
      } catch (err) {
        console.error('shipcue: board version failed', err);
        return fail('Something went wrong. Please try again.', 500);
      }
    }
    if (req.method === 'GET' && path === `${base}/board`) {
      try {
        return await board(req);
      } catch (err) {
        console.error('shipcue: board failed', err);
        return fail('Something went wrong. Please try again.', 500);
      }
    }
    if (path.startsWith(`${base}/team/`)) {
      try {
        return await teamApi(req, path.slice(`${base}/team`.length).split('/').filter(Boolean));
      } catch (err) {
        console.error('shipcue: team api failed', err);
        return fail('Something went wrong. Please try again.', 500);
      }
    }
    if (req.method === 'POST' && path === `${base}/digest`) {
      try {
        return await digestRoute(req);
      } catch (err) {
        console.error('shipcue: digest failed', err);
        return fail('Something went wrong. Please try again.', 500);
      }
    }
    if (!path.startsWith(`${base}/reports`)) return fail('Not found', 404);
    const parts = path.slice(`${base}/reports`.length).split('/').filter(Boolean);
    try {
      if (req.method === 'POST' && parts.length === 0) return await fileReport(req);
      if (req.method === 'POST' && parts.length === 2 && parts[1] === 'video' && parts[0]) return await attachVideo(req, parts[0]);
      return await agentApi(req, parts);
    } catch (err) {
      console.error('shipcue: handler failed', err);
      return fail('Something went wrong. Please try again.', 500);
    }
  };

  return async function handler(req: Request): Promise<Response> {
    const origin = opts.cors ? await corsAllows(req) : null;
    if (req.method === 'OPTIONS') {
      if (!origin) return new Response(null, { status: 404 });
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': origin,
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'content-type, authorization, x-shipcue-user',
          'access-control-max-age': '600',
          vary: 'Origin',
        },
      });
    }
    const res = await route(req);
    return origin ? withCors(res, origin) : res;
  };
}
