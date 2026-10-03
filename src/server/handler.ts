import { timingSafeEqual } from 'node:crypto';
import { BLOCKED_FILE_TYPES, formatBytes, resolveConfig, toAgentPrompt, toBoardItem, validateReport, videoExtension, videoType, type Board, type Capabilities, type ShipcueConfig, type Report } from '../core';
import type { ReportStore } from './store';
import { broadcast, type Broadcaster, type ShipcueEventType } from './broadcast';

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
  /** Bearer token for the agent API. Leave unset to switch the agent API off. */
  agentToken?: string;
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
const isImageLink = (u: string) => u.startsWith('/') || (u.startsWith('https://') && !/\.(?!png|jpe?g|webp|gif)[a-z0-9]{2,5}(?:[?#]|$)/i.test(u));

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
 *   POST {base}/reports/:id/close       agent: { status: fixed|wontfix, resolution }
 *
 * In Next.js: app/api/shipcue/[...path]/route.ts → export { handler as GET, handler as POST }.
 */
export function createShipcueHandler(opts: HandlerOptions): (req: Request) => Promise<Response> {
  const config = opts.config ?? resolveConfig();
  const base = (opts.basePath ?? '/api/shipcue').replace(/\/$/, '');
  const { store } = opts;
  const emit = (type: ShipcueEventType, report: Report | null) =>
    report ? broadcast(opts.broadcasters, { type, at: new Date().toISOString(), report }) : Promise.resolve();

  async function fileReport(req: Request): Promise<Response> {
    const reporter = opts.getReporter ? await opts.getReporter(req) : null;
    if (opts.requireReporter && !reporter) return fail('Sign in to send a report.', 401);

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
    for (const [i, f] of files.entries()) {
      const key = `${batch}/${i + 1}.${IMAGE_TYPES[f.type]}`;
      screenshots.push(opts.saveScreenshot ? await opts.saveScreenshot(f, key) : await toDataUrl(f, !IMAGE_TYPES[f.type]));
    }

    const report = await store.create({ ...checked.value, reporter, screenshots });
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

  async function agentApi(req: Request, parts: string[]): Promise<Response> {
    if (!opts.agentToken) return fail('Not found', 404);
    const auth = req.headers.get('authorization') ?? '';
    if (!auth.startsWith('Bearer ') || !sameToken(auth.slice(7), opts.agentToken)) return fail('Unauthorized', 401);

    const [id, action] = parts;
    if (req.method === 'GET' && !id) {
      const status = new URL(req.url).searchParams.get('status');
      const allowed = ['open', 'claimed', 'fixed', 'wontfix'] as const;
      const filter = allowed.find((s) => s === status);
      return json({ reports: await store.list(filter ? { status: filter } : {}) });
    }
    if (req.method === 'GET' && id && !action) {
      const r = await store.get(id);
      return r ? json(withPrompt(r)) : fail('No such report', 404);
    }
    if (req.method !== 'POST' || !id || !action) return fail('Not found', 404);

    const body = await readJson(req);
    const agentName = String(body.agent ?? 'agent').slice(0, 100);
    if (id === 'next' && action === 'claim') {
      const r = await store.claimNext(agentName);
      await emit('report.claimed', r);
      return r ? json(withPrompt(r)) : new Response(null, { status: 204 });
    }
    if (action === 'claim') {
      const r = await store.claim(id, agentName);
      await emit('report.claimed', r);
      if (r) return json(withPrompt(r));
      return (await store.get(id)) ? fail('Someone else has it', 409) : fail('No such report', 404);
    }
    if (action === 'release') {
      const r = await store.release(id);
      await emit('report.released', r);
      return r ? json({ report: r }) : fail('Not claimed', 409);
    }
    if (action === 'close') {
      if (body.status !== 'fixed' && body.status !== 'wontfix') return fail('status must be fixed or wontfix');
      const resolution = body.resolution == null ? null : String(body.resolution).slice(0, 2000);
      const r = await store.close(id, body.status, resolution);
      await emit('report.closed', r);
      return r ? json({ report: r }) : fail('No such report', 404);
    }
    return fail('Not found', 404);
  }

  const BOARD_LIMIT = 200;

  async function board(req: Request): Promise<Response> {
    const allowed = typeof opts.board === 'function' ? await opts.board(req) : opts.board === true;
    if (!allowed) return fail('Not found', 404);
    const [open, claimed, fixed] = await Promise.all([
      store.list({ status: 'open' }),
      store.list({ status: 'claimed' }),
      store.list({ status: 'fixed' }),
    ]);
    const item = (r: Report) => toBoardItem(r, opts.boardScreenshots ? boardShots(r) : undefined);
    const result: Board = {
      queue: [...claimed, ...open].slice(0, BOARD_LIMIT).map(item),
      changelog: fixed
        .map(item)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, BOARD_LIMIT),
    };
    return new Response(JSON.stringify(result), {
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }

  // Stored URLs pass through; data URLs become short links, so the board stays small.
  const boardShots = (r: Report) =>
    r.screenshots
      .map((src, n) => (src.startsWith('data:') ? (/^data:image\/(png|jpeg|webp|gif)[;,]/.test(src) ? `${base}/board/screenshot/${r.id}/${n}` : '') : src))
      .filter(isImageLink);

  async function boardScreenshot(req: Request, id: string, n: number): Promise<Response> {
    const allowed = typeof opts.board === 'function' ? await opts.board(req) : opts.board === true;
    if (!allowed || !opts.boardScreenshots) return fail('Not found', 404);
    const r = await store.get(id);
    // Only what the board lists: open, claimed or fixed.
    if (!r || !['open', 'claimed', 'fixed'].includes(r.status)) return fail('Not found', 404);
    const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/.exec(r.screenshots[n] ?? '');
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
