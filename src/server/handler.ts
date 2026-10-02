import { timingSafeEqual } from 'node:crypto';
import { formatBytes, resolveConfig, toAgentPrompt, toBoardItem, validateReport, videoExtension, videoType, type Board, type ShipcueConfig, type Report } from '../core';
import type { ReportStore } from './store';

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
const isImageLink = (u: string) => u.startsWith('/') || u.startsWith('https://');

async function toDataUrl(file: File): Promise<string> {
  const base64 = Buffer.from(await file.arrayBuffer()).toString('base64');
  return `data:${file.type};base64,${base64}`;
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
 *   POST {base}/reports/:id/video       the button attaches a video (multipart, field "video")
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

    const files = form.getAll('screenshot').filter((f): f is File => f instanceof File && f.size > 0);
    if (files.length > config.maxScreenshots) return fail(`Up to ${config.maxScreenshots} screenshots.`);
    for (const f of files) {
      if (!IMAGE_TYPES[f.type]) return fail('Screenshots must be PNG, JPG, WebP or GIF.');
      if (f.size > config.maxScreenshotBytes) {
        return fail(`Each screenshot must be under ${Math.round(config.maxScreenshotBytes / 1024 / 1024)} MB.`);
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
      screenshots.push(opts.saveScreenshot ? await opts.saveScreenshot(f, key) : await toDataUrl(f));
    }

    const report = await store.create({ ...checked.value, reporter, screenshots });
    if (opts.onReport) {
      try {
        await opts.onReport(report);
      } catch (err) {
        console.error('shipcue: onReport failed', err);
      }
    }
    return json({ id: report.id }, 201);
  }

  // A video can be attached by whoever filed the report, once, within this window.
  const VIDEO_WINDOW_MS = 30 * 60 * 1000;

  async function attachVideo(req: Request, id: string): Promise<Response> {
    if (!opts.saveVideo) return fail('Not found', 404);
    const report = await store.get(id);
    if (!report) return fail('No such report', 404);
    const reporter = opts.getReporter ? await opts.getReporter(req) : null;
    if (report.reporter !== null && report.reporter !== reporter) return fail('Not your report.', 403);
    if (Date.now() - Date.parse(report.createdAt) > VIDEO_WINDOW_MS) return fail('Too late to add a video to this report.', 403);
    if (report.video) return fail('This report already has a video.', 409);

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

    const url = await opts.saveVideo(file, `${id}/video.${videoExtension(type)}`);
    const saved = await store.attachVideo(id, url);
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
      return r ? json(withPrompt(r)) : new Response(null, { status: 204 });
    }
    if (action === 'claim') {
      const r = await store.claim(id, agentName);
      if (r) return json(withPrompt(r));
      return (await store.get(id)) ? fail('Someone else has it', 409) : fail('No such report', 404);
    }
    if (action === 'release') {
      const r = await store.release(id);
      return r ? json({ report: r }) : fail('Not claimed', 409);
    }
    if (action === 'close') {
      if (body.status !== 'fixed' && body.status !== 'wontfix') return fail('status must be fixed or wontfix');
      const resolution = body.resolution == null ? null : String(body.resolution).slice(0, 2000);
      const r = await store.close(id, body.status, resolution);
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
    r.screenshots.map((src, n) => (src.startsWith('data:') ? `${base}/board/screenshot/${r.id}/${n}` : src)).filter(isImageLink);

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

  return async function handler(req: Request): Promise<Response> {
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
}
