// shipcue Cloud: projects, teams, invites and agents on top of the package's handler. Each project's
// queue lives in the shared shipcue_reports table under its project_id, served at
// {base}/p/<public key>/... with the same routes as a self-hosted handler (button, agent API, team API).
// Sign-in is InsForge auth on shipcue's project, kept server-side in httpOnly cookies.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { DIGEST_PERIOD_MS, EVENT_TYPES, broadcast, createShipcueHandler, digest, emailDigest, postgresStore, slack, slackDigest, webhook } from '../../src/server';
import { SHIPCUE_VERSION, compareVersions, parseVersion, resolveConfig } from '../../src/core';
import { triageReport } from './hosted.mjs';

const ROLES = ['owner', 'member', 'viewer'];
const TYPES = ['bug', 'feature', 'task'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ORIGIN = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i;
const AGENT_NAME = /^[a-z0-9][a-z0-9._@-]{0,59}$/;
const UUID = /^[0-9a-f-]{36}$/i;
const ACCESS_COOKIE = 'sc_at';
const REFRESH_COOKIE = 'sc_rt';
// The PKCE verifier between "Continue with Google" and the way back.
const PKCE_COOKIE = 'sc_pkce';
const OAUTH_PROVIDERS = ['google', 'github'];
// Who is filing, as the site's button says (ReportButton's `reporter`): printable text, capped.
const REPORTER_HEADER = 'x-shipcue-user';
const MAX_REPORTER = 200;
// The hosted agent's name in the CueLog (shipcue report 3d2dded6); no one else's agent can take it.
const HOSTED_NAME = 'shipcue-agent';

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
const fail = (error, status = 400) => json({ error }, status);
const sha256 = (t) => createHash('sha256').update(t).digest('hex');
const reporterFrom = (req) => {
  const raw = (req.headers.get(REPORTER_HEADER) ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return raw ? raw.slice(0, MAX_REPORTER) : null;
};
const nameFromEmail = (email) => email.split('@')[0].slice(0, 80) || email.slice(0, 80);

function cookies(req) {
  const out = {};
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function body(req) {
  try {
    const b = await req.json();
    return b && typeof b === 'object' ? b : {};
  } catch {
    return {};
  }
}

/** InsForge auth over REST, as a server client (tokens come back in the body, not cookies). */
export function insforgeAuth(baseUrl, fetchImpl = fetch) {
  const call = async (path, payload, token) => {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method: payload ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.message ?? data.error ?? `Sign-in service said ${res.status}`), { status: res.status });
    return data;
  };
  const tokens = (d) => (d.accessToken ? { accessToken: d.accessToken, refreshToken: d.refreshToken, user: d.user } : null);
  return {
    async signUp(email, password) {
      const d = await call('/api/auth/users?client_type=server', { email, password });
      return { tokens: tokens(d), needsVerification: !d.accessToken };
    },
    async verify(email, otp) {
      return tokens(await call('/api/auth/email/verify?client_type=server', { email, otp }));
    },
    async resend(email) {
      await call('/api/auth/email/send-verification', { email });
    },
    async signIn(email, password) {
      return tokens(await call('/api/auth/sessions?client_type=server', { email, password }));
    },
    async current(accessToken) {
      const d = await call('/api/auth/sessions/current', null, accessToken);
      return d.user ? { id: d.user.id, email: d.user.email } : null;
    },
    async refresh(refreshToken) {
      return tokens(await call('/api/auth/refresh?client_type=server', { refreshToken }));
    },
    /** The provider's sign-in page (Google, GitHub) for a PKCE challenge; it comes back to redirectUri with ?insforge_code. */
    async oauthUrl(provider, redirectUri, codeChallenge) {
      const qs = new URLSearchParams({ redirect_uri: redirectUri, code_challenge: codeChallenge });
      const d = await call(`/api/auth/oauth/${encodeURIComponent(provider)}?${qs}`);
      if (typeof d.authUrl !== 'string' || !d.authUrl.startsWith('https://')) throw new Error('The sign-in service gave no sign-in page.');
      return d.authUrl;
    },
    async exchange(code, codeVerifier) {
      return tokens(await call('/api/auth/oauth/exchange?client_type=server', { code, code_verifier: codeVerifier }));
    },
  };
}

/** The signed-in Cloud user from the request's cookies, or null. Refreshes without saving: for read-only callers. */
export async function cloudUserFrom(req, auth) {
  const c = cookies(req);
  if (c[ACCESS_COOKIE]) {
    try {
      const user = await auth.current(c[ACCESS_COOKIE]);
      if (user) return user;
    } catch {
      // Expired: try the refresh token.
    }
  }
  if (c[REFRESH_COOKIE]) {
    try {
      const t = await auth.refresh(c[REFRESH_COOKIE]);
      if (t) return t.user ? { id: t.user.id, email: t.user.email } : await auth.current(t.accessToken);
    } catch {
      // Signed out.
    }
  }
  return null;
}

/** Sends one email with InsForge's emails on shipcue's project; null without a key. */
export function insforgeEmail(baseUrl, apiKey, fetchImpl = fetch) {
  if (!apiKey) return null;
  return async (m) => {
    const res = await fetchImpl(`${baseUrl}/api/email/send-raw`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ to: m.to, subject: m.subject, html: m.html, from: 'shipcue' }),
    });
    if (!res.ok) throw new Error(`email: ${res.status} ${(await res.text()).slice(0, 200)}`);
  };
}

/**
 * An app's shipcue endpoint for the All projects view (shipcue report e4e1a85e): https, no credentials,
 * no trailing slash. Null when empty; undefined when it is not one.
 */
export function cleanAppUrl(v) {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  let url;
  try {
    url = new URL(String(v).trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return undefined;
  const out = url.toString().replace(/\/+$/, '');
  return out.length <= 500 ? out : undefined;
}

/**
 * The version an app's shipcue runs, from its /capabilities: fetched with a short timeout and cached
 * briefly, so the All projects view never waits long or asks every app on every load. Null when the app
 * is slow, down, older than the version field, or says something that is not a version.
 */
export function appVersions({ fetchImpl = fetch, timeoutMs = 2500, cacheMs = 5 * 60_000 } = {}) {
  const cache = new Map();
  async function fetchOne(appUrl) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await Promise.race([
        fetchImpl(`${appUrl}/capabilities`, { signal: ctl.signal, redirect: 'error', headers: { accept: 'application/json', 'user-agent': 'shipcue-cloud' } }),
        new Promise((_, reject) => ctl.signal.addEventListener('abort', () => reject(new Error('timeout')))),
      ]);
      if (!res.ok) return null;
      const caps = await res.json();
      return parseVersion(caps?.version) ? String(caps.version).trim().replace(/^v/, '') : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return async function versionOf(appUrl) {
    const hit = cache.get(appUrl);
    if (hit && Date.now() - hit.at < cacheMs) return hit.version;
    const version = await fetchOne(appUrl);
    if (cacheMs > 0) cache.set(appUrl, { at: Date.now(), version });
    return version;
  };
}

const DIGEST_EVERY = ['off', 'hour', 'day'];
const DIGEST_TO = ['slack', 'email'];
// A cron's runs wander (Vercel's daily cron anywhere in its hour), so a period counts as done this close to its end.
const DIGEST_EARLY_SHARE = 0.1;

/**
 * Whether a project's digest is due now (shipcue report 5f4d339b), and the period it covers: from the
 * end of the last one sent, or one period back when none was sent lately (so turning it on, or a long
 * gap, never digests weeks of history).
 */
export function digestDue(p, now = new Date()) {
  const period = DIGEST_PERIOD_MS[p?.digest_every];
  if (!period) return null;
  const last = p.digest_sent_at ? new Date(p.digest_sent_at).getTime() : null;
  const gap = last === null ? Infinity : now.getTime() - last;
  if (gap < period * (1 - DIGEST_EARLY_SHARE)) return null;
  return { since: new Date(gap <= 2 * period ? last : now.getTime() - period), until: now };
}

/**
 * @param {{ db: { query(text: string, params?: unknown[]): Promise<{ rows: any[] }> }, auth: ReturnType<typeof insforgeAuth>,
 *   base?: string, beta?: string[], secureCookies?: boolean, refreshDays?: number, cookiePath?: string, appPath?: string }} opts
 *   appPath: where Continue with Google lands, signed in or with ?error= (default /app/).
 *   beta: emails that may create projects during the invite-only beta. Everyone else joins by invite.
 *   hosted: the hosted agent's OpenAI settings (hostedFromEnv in hosted.mjs), or null to leave it off on this server.
 *   background: keeps work running after the response (Vercel: waitUntil); by default it just runs.
 *   cronSecret: turns on GET|POST {base}/digest for a cron (Authorization: Bearer <cronSecret>), which sends due digests.
 *   sendEmail: sends one email ({ to, subject, html, text }), for digests to the owner's email; null leaves email off.
 *   latestVersion: the newest shipcue, which apps are compared to in All projects (default: this build's SHIPCUE_VERSION).
 *   fetch, versionTimeoutMs, versionCacheMs: how All projects reads each app's /capabilities (defaults: fetch, 2500, 5 minutes).
 */
export function createCloudHandler(opts) {
  const { db, auth } = opts;
  const hosted = opts.hosted ?? null;
  const background =
    opts.background ??
    ((work) => {
      void work;
    });
  const base = (opts.base ?? '/api/cloud').replace(/\/$/, '');
  const beta = new Set((opts.beta ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean));
  const secure = opts.secureCookies !== false;
  const refreshDays = opts.refreshDays ?? 30;
  const q = async (text, params = []) => (await db.query(text, params)).rows;
  const sendEmail = opts.sendEmail ?? null;
  const latestVersion = opts.latestVersion ?? SHIPCUE_VERSION;
  const versionOf = appVersions({ fetchImpl: opts.fetch, timeoutMs: opts.versionTimeoutMs, cacheMs: opts.versionCacheMs });

  // Path /api: the site's own report button (/api/shipcue) knows who is signed in too.
  const cookiePath = opts.cookiePath ?? '/api';
  const cookie = (name, value, maxAge) =>
    `${name}=${encodeURIComponent(value)}; Path=${cookiePath}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  const sessionCookies = (t) => [cookie(ACCESS_COOKIE, t.accessToken, 60 * 60 * 24), cookie(REFRESH_COOKIE, t.refreshToken ?? '', 60 * 60 * 24 * refreshDays)];
  const clearCookies = () => [cookie(ACCESS_COOKIE, '', 0), cookie(REFRESH_COOKIE, '', 0)];
  const withCookies = (res, set) => {
    if (!set?.length) return res;
    const headers = new Headers(res.headers);
    for (const c of set) headers.append('set-cookie', c);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };

  /** The signed-in user, refreshing the session when the access token ran out. */
  const sessions = new WeakMap();
  function session(req) {
    let s = sessions.get(req);
    if (!s) {
      s = (async () => {
        const c = cookies(req);
        if (c[ACCESS_COOKIE]) {
          try {
            const user = await auth.current(c[ACCESS_COOKIE]);
            if (user) return { user, set: [] };
          } catch {
            // Expired: try the refresh token.
          }
        }
        if (c[REFRESH_COOKIE]) {
          try {
            const t = await auth.refresh(c[REFRESH_COOKIE]);
            if (t) {
              const user = t.user ? { id: t.user.id, email: t.user.email } : await auth.current(t.accessToken);
              if (user) return { user, set: sessionCookies(t) };
            }
          } catch {
            // Signed out for good.
          }
        }
        return null;
      })();
      sessions.set(req, s);
    }
    return s;
  }

  /** Cookie-authenticated writes must be JSON, which a cross-site form cannot send. */
  const jsonWrite = (req) => req.method !== 'POST' || (req.headers.get('content-type') ?? '').startsWith('application/json');

  const memberOf = async (projectId, userId) =>
    (await q(`SELECT id, project_id, user_id, email, name, role FROM cloud_members WHERE project_id = $1 AND user_id = $2 AND NOT is_deleted`, [projectId, userId]))[0] ?? null;
  const projectRow = async (id) =>
    (await q(`SELECT * FROM cloud_projects WHERE id = $1 AND NOT is_deleted`, [id]))[0] ?? null;
  const publicProject = (p) => ({
    id: p.id,
    name: p.name,
    publicKey: p.public_key,
    allowedOrigins: p.allowed_origins,
    leaseSeconds: p.lease_seconds,
    staleDays: p.stale_days,
    agentPull: p.agent_pull,
    areas: p.areas,
    publicBoard: p.public_board,
    // Forwarding: Slack's URL is a secret, so only whether it is set; the webhook's URL shows.
    slackConnected: !!p.slack_webhook_url,
    webhookUrl: p.webhook_url ?? null,
    notifyEvents: p.notify_events ?? ['report.filed', 'report.closed'],
    hostedAgent: !!p.hosted_agent,
    hostedAutoTriage: !!p.hosted_auto_triage,
    digestEvery: p.digest_every ?? 'off',
    digestTo: p.digest_to ?? 'slack',
    digestSentAt: p.digest_sent_at ? new Date(p.digest_sent_at).toISOString() : null,
    // The GitHub webhook (shipcue report 919f5ca2): only whether it is on; its secret is shown once.
    githubConnected: !!p.github_secret,
    appUrl: p.app_url ?? null,
    createdAt: new Date(p.created_at).toISOString(),
  });

  /** Joins every open invite for this email. */
  async function acceptInvites(user) {
    const invites = await q(
      `SELECT i.id, i.project_id, i.role FROM cloud_invites i JOIN cloud_projects p ON p.id = i.project_id AND NOT p.is_deleted
        WHERE lower(i.email) = lower($1) AND i.accepted_at IS NULL AND i.revoked_at IS NULL`,
      [user.email],
    );
    for (const inv of invites) {
      if (!(await memberOf(inv.project_id, user.id))) {
        await q(`INSERT INTO cloud_members (project_id, user_id, email, name, role) VALUES ($1, $2, $3, $4, $5)`, [
          inv.project_id,
          user.id,
          user.email,
          nameFromEmail(user.email),
          inv.role,
        ]);
      }
      await q(`UPDATE cloud_invites SET accepted_at = now() WHERE id = $1`, [inv.id]);
    }
  }

  async function canCreate(user) {
    if (beta.has(user.email.toLowerCase())) return true;
    // Anyone who already owns a project may make another.
    return (await q(`SELECT 1 FROM cloud_members WHERE user_id = $1 AND role = 'owner' AND NOT is_deleted LIMIT 1`, [user.id])).length > 0;
  }

  // Continue with Google (or GitHub): off to the provider with a PKCE challenge, back to /callback, then /app/.
  const appPath = opts.appPath ?? '/app/';
  const pkceCookie = (value, maxAge) =>
    `${PKCE_COOKIE}=${encodeURIComponent(value)}; Path=${base}/auth/oauth; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  const redirect = (location, set = []) => {
    const headers = new Headers({ location, 'cache-control': 'no-store' });
    for (const c of set) headers.append('set-cookie', c);
    return new Response(null, { status: 302, headers });
  };
  const toApp = (req, error, set = []) => {
    const url = new URL(appPath, req.url);
    if (error) url.searchParams.set('error', error);
    return redirect(url.toString(), set);
  };
  async function oauth(req, step) {
    if (OAUTH_PROVIDERS.includes(step)) {
      const verifier = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      try {
        const url = await auth.oauthUrl(step, new URL(`${base}/auth/oauth/callback`, req.url).toString(), challenge);
        return redirect(url, [pkceCookie(verifier, 600)]);
      } catch (err) {
        return toApp(req, err.message || 'Could not reach the sign-in service.');
      }
    }
    if (step !== 'callback') return fail('Not found', 404);
    const params = new URL(req.url).searchParams;
    const clear = [pkceCookie('', 0)];
    const code = params.get('insforge_code');
    if (params.get('error') || !code) return toApp(req, params.get('error_description') || params.get('error') || 'Sign-in was cancelled.', clear);
    const verifier = cookies(req)[PKCE_COOKIE];
    if (!verifier) return toApp(req, 'That sign-in took too long or started in another browser. Please try again.', clear);
    try {
      const t = await auth.exchange(code, verifier);
      if (!t) return toApp(req, 'Could not sign in.', clear);
      return toApp(req, null, [...clear, ...sessionCookies(t)]);
    } catch (err) {
      return toApp(req, err.message || 'Could not sign in.', clear);
    }
  }

  async function authRoutes(req, action, step) {
    if (action === 'oauth' && req.method === 'GET') return oauth(req, step);
    if (req.method !== 'POST') return fail('Not found', 404);
    const b = await body(req);
    const email = String(b.email ?? '').trim().toLowerCase();
    try {
      if (action === 'sign-out') return withCookies(json({ ok: true }), clearCookies());
      if (!EMAIL.test(email)) return fail('Enter your email.');
      if (action === 'sign-up') {
        const password = String(b.password ?? '');
        if (password.length < 8) return fail('Use at least 8 characters for the password.');
        const r = await auth.signUp(email, password);
        if (r.tokens) return withCookies(json({ user: { email } }), sessionCookies(r.tokens));
        return json({ needsVerification: true });
      }
      if (action === 'verify') {
        const t = await auth.verify(email, String(b.otp ?? '').trim());
        return t ? withCookies(json({ user: { email } }), sessionCookies(t)) : json({ needsSignIn: true });
      }
      if (action === 'resend') {
        await auth.resend(email);
        return json({ ok: true });
      }
      if (action === 'sign-in') {
        const t = await auth.signIn(email, String(b.password ?? ''));
        if (!t) return fail('Could not sign in.', 401);
        return withCookies(json({ user: { email } }), sessionCookies(t));
      }
    } catch (err) {
      return fail(err.message || 'Could not sign in.', err.status === 401 || err.status === 403 ? 401 : 400);
    }
    return fail('Not found', 404);
  }

  async function me(user) {
    await acceptInvites(user);
    const projects = await q(
      `SELECT p.id, p.name, p.public_key, m.role FROM cloud_members m JOIN cloud_projects p ON p.id = m.project_id AND NOT p.is_deleted
        WHERE m.user_id = $1 AND NOT m.is_deleted ORDER BY p.created_at`,
      [user.id],
    );
    return json({
      user,
      canCreate: await canCreate(user),
      projects: projects.map((p) => ({ id: p.id, name: p.name, publicKey: p.public_key, role: p.role })),
    });
  }

  /**
   * All projects (shipcue report e4e1a85e): every project the user is a member of, with what is open,
   * claimed and in review, how long the oldest open report has waited, claims stuck past their lease,
   * and open reports nobody has looked at (never claimed, assigned or noted). Only the user's own
   * memberships are read, so no other project ever shows.
   */
  async function overview(user) {
    await acceptInvites(user);
    const rows = await q(
      `WITH mine AS (
         SELECT p.id, p.name, p.public_key, p.app_url, p.created_at, m.role FROM cloud_members m
           JOIN cloud_projects p ON p.id = m.project_id AND NOT p.is_deleted
          WHERE m.user_id = $1 AND NOT m.is_deleted),
       r AS (
         SELECT r.*, (r.status = 'open' AND r.claimant_id IS NULL AND NOT EXISTS (
                  SELECT 1 FROM shipcue_report_events e WHERE e.report_id = r.id AND e.action IN ('claimed', 'assigned', 'note'))) AS unlooked
           FROM shipcue_reports r JOIN mine ON mine.id = r.project_id
          WHERE NOT r.is_deleted AND r.status IN ('open', 'claimed', 'in_review'))
       SELECT mine.id, mine.name, mine.public_key, mine.app_url, mine.role,
              count(r.id) FILTER (WHERE r.status = 'open')::int AS open,
              count(r.id) FILTER (WHERE r.status = 'claimed')::int AS claimed,
              count(r.id) FILTER (WHERE r.status = 'in_review')::int AS in_review,
              count(r.id) FILTER (WHERE r.status = 'claimed' AND r.lease_expires_at < now())::int AS stuck,
              count(r.id) FILTER (WHERE r.unlooked)::int AS unlooked,
              min(r.created_at) FILTER (WHERE r.status = 'open') AS oldest_open_at,
              coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'type', r.type, 'description', left(r.description, 400), 'createdAt', r.created_at)
                         ORDER BY r.created_at) FILTER (WHERE r.unlooked), '[]'::jsonb) AS unlooked_reports
         FROM mine LEFT JOIN r ON r.project_id = mine.id
        GROUP BY mine.id, mine.name, mine.public_key, mine.app_url, mine.role, mine.created_at
        ORDER BY mine.created_at`,
      [user.id],
    );
    const headlineOf = (text) => (String(text).trim().split('\n')[0] ?? '').slice(0, 120);
    return json({
      latest: latestVersion,
      projects: rows.map((p) => ({
        id: p.id,
        name: p.name,
        publicKey: p.public_key,
        role: p.role,
        appUrl: p.app_url ?? null,
        open: p.open,
        claimed: p.claimed,
        inReview: p.in_review,
        stuck: p.stuck,
        unlooked: p.unlooked,
        oldestOpenAt: p.oldest_open_at ? new Date(p.oldest_open_at).toISOString() : null,
        // The oldest few, so the view can list them; the count above is the whole number.
        unlookedReports: (typeof p.unlooked_reports === 'string' ? JSON.parse(p.unlooked_reports) : p.unlooked_reports).slice(0, 20).map((x) => ({
          id: x.id,
          type: x.type,
          headline: headlineOf(x.description),
          createdAt: new Date(x.createdAt).toISOString(),
        })),
      })),
    });
  }

  /** The version each of the user's apps runs, for projects with an app URL; asked separately so the overview never waits on it. */
  async function overviewVersions(user) {
    const rows = await q(
      `SELECT p.id, p.app_url FROM cloud_members m JOIN cloud_projects p ON p.id = m.project_id AND NOT p.is_deleted
        WHERE m.user_id = $1 AND NOT m.is_deleted AND p.app_url IS NOT NULL`,
      [user.id],
    );
    const entries = await Promise.all(
      rows.map(async (p) => {
        const version = await versionOf(p.app_url);
        const cmp = version ? compareVersions(version, latestVersion) : null;
        return [p.id, { version, behind: cmp === null ? null : cmp < 0 }];
      }),
    );
    return json({ latest: latestVersion, versions: Object.fromEntries(entries) });
  }

  async function projectRoutes(req, user, parts) {
    const [id, section, subId, subAction] = parts;
    if (!id) {
      if (req.method !== 'POST') return fail('Not found', 404);
      if (!(await canCreate(user))) return fail('shipcue Cloud is invite-only for now. Ask to join the beta.', 403);
      const b = await body(req);
      const name = String(b.name ?? '').trim().slice(0, 80);
      if (!name) return fail('Name the project.');
      const key = `pk_${randomBytes(12).toString('hex')}`;
      const [p] = await q(`INSERT INTO cloud_projects (name, public_key, created_by) VALUES ($1, $2, $3) RETURNING *`, [name, key, user.id]);
      await q(`INSERT INTO cloud_members (project_id, user_id, email, name, role) VALUES ($1, $2, $3, $4, 'owner')`, [p.id, user.id, user.email, nameFromEmail(user.email)]);
      return json({ project: publicProject(p) }, 201);
    }
    if (!UUID.test(id)) return fail('Not found', 404);
    const p = await projectRow(id);
    const m = p && (await memberOf(id, user.id));
    if (!p || !m) return fail('Not found', 404);
    const owner = m.role === 'owner';

    if (req.method === 'GET' && !section) {
      const [members, invites, agents] = await Promise.all([
        q(`SELECT id, user_id, email, name, role FROM cloud_members WHERE project_id = $1 AND NOT is_deleted ORDER BY created_at`, [id]),
        owner ? q(`SELECT id, email, role, created_at FROM cloud_invites WHERE project_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL ORDER BY created_at`, [id]) : [],
        q(`SELECT id, name, owner_user_id, owner_name, pull, types, last_seen_at, created_at FROM cloud_agents WHERE project_id = $1 AND revoked_at IS NULL AND NOT hosted ORDER BY created_at`, [id]),
      ]);
      return json({
        project: publicProject(p),
        role: m.role,
        members: members.map((x) => ({ id: x.id, userId: x.user_id, email: x.email, name: x.name, role: x.role })),
        invites: invites.map((x) => ({ id: x.id, email: x.email, role: x.role, createdAt: new Date(x.created_at).toISOString() })),
        agents: agents.map((a) => ({
          id: a.id,
          name: a.name,
          ownerUserId: a.owner_user_id,
          ownerName: a.owner_name,
          pull: a.pull,
          types: a.types,
          lastSeenAt: a.last_seen_at ? new Date(a.last_seen_at).toISOString() : null,
        })),
        // Whether this server can run the hosted agent, and its daily cap per project.
        hosted: { available: !!hosted, name: HOSTED_NAME, dailyLimit: hosted?.dailyLimit ?? null },
        // Whether this server can send digests, and by email.
        digest: { available: !!opts.cronSecret, email: !!sendEmail },
      });
    }
    if (req.method !== 'POST') return fail('Not found', 404);
    const b = await body(req);

    if (section === 'rotate-key') {
      if (!owner) return fail('Only owners can change the key.', 403);
      const [row] = await q(`UPDATE cloud_projects SET public_key = $2, updated_at = now() WHERE id = $1 RETURNING *`, [id, `pk_${randomBytes(12).toString('hex')}`]);
      return json({ project: publicProject(row) });
    }
    if (section === 'delete') {
      if (!owner) return fail('Only owners can delete the project.', 403);
      await q(`UPDATE cloud_projects SET is_deleted = true, deleted_at = now(), updated_at = now() WHERE id = $1`, [id]);
      return json({ ok: true });
    }

    if (section === 'settings') {
      if (!owner) return fail('Only owners can change settings.', 403);
      const sets = [];
      const params = [id];
      const set = (col, v) => {
        params.push(v);
        sets.push(`${col} = $${params.length}`);
      };
      if (b.name !== undefined) {
        const name = String(b.name).trim().slice(0, 80);
        if (!name) return fail('Name the project.');
        set('name', name);
      }
      if (b.allowedOrigins !== undefined) {
        const origins = Array.isArray(b.allowedOrigins) ? b.allowedOrigins.map((o) => String(o).trim().replace(/\/$/, '')).filter(Boolean) : null;
        if (!origins || origins.length > 20 || !origins.every((o) => ORIGIN.test(o))) return fail('Origins look like https://app.example.com (up to 20).');
        set('allowed_origins', origins);
      }
      if (b.leaseSeconds !== undefined) {
        const v = b.leaseSeconds === null ? null : Number(b.leaseSeconds);
        if (v !== null && !(Number.isInteger(v) && v >= 60 && v <= 604800)) return fail('Leases run from 60 seconds to 7 days, or none.');
        set('lease_seconds', v);
      }
      if (b.staleDays !== undefined) {
        const v = Number(b.staleDays);
        if (!(Number.isInteger(v) && v >= 1 && v <= 365)) return fail('Stale after 1 to 365 days.');
        set('stale_days', v);
      }
      if (b.agentPull !== undefined) set('agent_pull', b.agentPull === true);
      if (b.publicBoard !== undefined) set('public_board', b.publicBoard === true);
      if (b.areas !== undefined) {
        const areas = Array.isArray(b.areas) ? b.areas : null;
        const ok =
          areas &&
          areas.length <= 50 &&
          areas.every((a) => a && /^[a-z0-9-]{1,40}$/.test(String(a.value)) && String(a.label ?? '').trim().length > 0 && String(a.label).length <= 60);
        if (!ok) return fail('Areas are { value: "editor", label: "Editor" } (up to 50).');
        set('areas', JSON.stringify(areas.map((a) => ({ value: String(a.value), label: String(a.label).trim() }))));
      }
      // Forwarding (Slack, a signed webhook). A new webhook URL gets a new secret, shown once.
      let webhookSecret = null;
      if (b.slackWebhookUrl !== undefined) {
        const v = b.slackWebhookUrl === null || b.slackWebhookUrl === '' ? null : String(b.slackWebhookUrl).trim();
        if (v !== null && !/^https:\/\/hooks\.slack\.com\/[\w/-]+$/.test(v)) return fail('Use a Slack incoming webhook URL (https://hooks.slack.com/...).');
        set('slack_webhook_url', v);
      }
      if (b.webhookUrl !== undefined) {
        const v = b.webhookUrl === null || b.webhookUrl === '' ? null : String(b.webhookUrl).trim();
        if (v !== null && !(/^https:\/\/[^\s]+$/.test(v) && v.length <= 500)) return fail('Webhooks need an https:// URL.');
        set('webhook_url', v);
        webhookSecret = v ? `whsec_${randomBytes(24).toString('hex')}` : null;
        set('webhook_secret', webhookSecret);
      }
      // The GitHub webhook's secret (shipcue report 919f5ca2): turning it on (again) makes a new one, shown once.
      let githubSecret = null;
      if (b.githubWebhook !== undefined) {
        githubSecret = b.githubWebhook === true ? `ghsec_${randomBytes(24).toString('hex')}` : null;
        set('github_secret', githubSecret);
      }
      if (b.notifyEvents !== undefined) {
        const events = Array.isArray(b.notifyEvents) ? b.notifyEvents : null;
        if (!events || !events.every((e) => EVENT_TYPES.includes(e))) return fail(`Events are ${EVENT_TYPES.join(', ')}.`);
        set('notify_events', [...new Set(events)]);
      }
      // The hosted agent (shipcue report 3d2dded6): turning it on makes its agent row, off retires it.
      let hostedOn;
      if (b.hostedAgent !== undefined) {
        hostedOn = b.hostedAgent === true;
        if (hostedOn && !hosted) return fail('The hosted agent is not available on this server.', 409);
        if (hostedOn && (await q(`SELECT 1 FROM cloud_agents WHERE project_id = $1 AND name = $2 AND revoked_at IS NULL AND NOT hosted`, [id, HOSTED_NAME])).length) {
          return fail(`Disconnect your agent named ${HOSTED_NAME} first.`, 409);
        }
        set('hosted_agent', hostedOn);
      }
      if (b.hostedAutoTriage !== undefined) set('hosted_auto_triage', b.hostedAutoTriage === true);
      // The activity digest (shipcue report 5f4d339b): how often, and to Slack or the owner's email.
      if (b.digestEvery !== undefined) {
        if (!DIGEST_EVERY.includes(b.digestEvery)) return fail('A digest goes out off, hourly or daily.');
        set('digest_every', b.digestEvery);
      }
      if (b.digestTo !== undefined) {
        if (!DIGEST_TO.includes(b.digestTo)) return fail('A digest goes to Slack or email.');
        if (b.digestTo === 'email' && !sendEmail) return fail('Email digests are not available on this server.', 409);
        set('digest_to', b.digestTo);
      }
      if (b.appUrl !== undefined) {
        const v = cleanAppUrl(b.appUrl);
        if (v === undefined) return fail("The app's shipcue endpoint is an https:// URL, like https://app.example.com/api/shipcue.");
        set('app_url', v);
      }
      if (!sets.length) return fail('Nothing to change.');
      const [row] = await q(`UPDATE cloud_projects SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, params);
      if (hostedOn === true && !(await q(`SELECT 1 FROM cloud_agents WHERE project_id = $1 AND hosted AND revoked_at IS NULL`, [id])).length) {
        await q(
          `INSERT INTO cloud_agents (project_id, name, token_hash, owner_user_id, owner_name, pull, hosted) VALUES ($1, $2, NULL, $3, $4, false, true)`,
          [id, HOSTED_NAME, user.id, m.name],
        );
      }
      if (hostedOn === false) {
        const gone = await q(`UPDATE cloud_agents SET revoked_at = now() WHERE project_id = $1 AND hosted AND revoked_at IS NULL RETURNING id`, [id]);
        // Reports still queued for it go back to the queue.
        const store = postgresStore(db, 'shipcue_reports', { project: id });
        const by = { kind: 'person', id: user.id, name: m.name };
        for (const a of gone) for (const r of await store.list({ claimant: a.id })) await store.release(r.id, { by });
      }
      return json({ project: publicProject(row), ...(webhookSecret ? { webhookSecret } : {}), ...(githubSecret ? { githubSecret } : {}) });
    }

    if (section === 'invites') {
      if (!owner) return fail('Only owners can invite.', 403);
      if (subId && subAction === 'revoke') {
        if (!UUID.test(subId)) return fail('Not found', 404);
        await q(`UPDATE cloud_invites SET revoked_at = now() WHERE id = $1 AND project_id = $2 AND accepted_at IS NULL`, [subId, id]);
        return json({ ok: true });
      }
      const email = String(b.email ?? '').trim().toLowerCase();
      const role = ROLES.includes(b.role) ? b.role : 'member';
      if (!EMAIL.test(email)) return fail('Enter their email.');
      const existing = await q(
        `SELECT 1 FROM cloud_members WHERE project_id = $1 AND lower(email) = $2 AND NOT is_deleted UNION ALL
         SELECT 1 FROM cloud_invites WHERE project_id = $1 AND lower(email) = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
        [id, email],
      );
      if (existing.length) return fail('They are already on the team or invited.', 409);
      const [inv] = await q(`INSERT INTO cloud_invites (project_id, email, role, invited_by) VALUES ($1, $2, $3, $4) RETURNING id, email, role`, [id, email, role, user.id]);
      return json({ invite: inv }, 201);
    }

    if (section === 'members' && subId && UUID.test(subId)) {
      if (!owner) return fail('Only owners can change the team.', 403);
      const target = (await q(`SELECT id, role FROM cloud_members WHERE id = $1 AND project_id = $2 AND NOT is_deleted`, [subId, id]))[0];
      if (!target) return fail('Not found', 404);
      const owners = Number((await q(`SELECT count(*)::int AS n FROM cloud_members WHERE project_id = $1 AND role = 'owner' AND NOT is_deleted`, [id]))[0].n);
      const lastOwner = target.role === 'owner' && owners <= 1;
      if (subAction === 'role') {
        if (!ROLES.includes(b.role)) return fail('Pick a role.');
        if (lastOwner && b.role !== 'owner') return fail('A project needs at least one owner.', 409);
        await q(`UPDATE cloud_members SET role = $1 WHERE id = $2`, [b.role, subId]);
        return json({ ok: true });
      }
      if (subAction === 'remove') {
        if (lastOwner) return fail('A project needs at least one owner.', 409);
        await q(`UPDATE cloud_members SET is_deleted = true, deleted_at = now() WHERE id = $1`, [subId]);
        return json({ ok: true });
      }
    }

    if (section === 'agents') {
      if (m.role === 'viewer') return fail('Viewers cannot connect agents.', 403);
      if (subId && subAction === 'revoke') {
        if (!UUID.test(subId)) return fail('Not found', 404);
        const a = (await q(`SELECT owner_user_id FROM cloud_agents WHERE id = $1 AND project_id = $2 AND revoked_at IS NULL AND NOT hosted`, [subId, id]))[0];
        if (!a) return fail('Not found', 404);
        if (!owner && a.owner_user_id !== user.id) return fail('Only an owner or whoever connected it can disconnect it.', 403);
        await q(`UPDATE cloud_agents SET revoked_at = now() WHERE id = $1`, [subId]);
        return json({ ok: true });
      }
      const name = String(b.name ?? '').trim().toLowerCase();
      if (!AGENT_NAME.test(name)) return fail('Agent names are lowercase letters, numbers and . _ @ - (up to 60).');
      if (name === HOSTED_NAME) return fail(`${HOSTED_NAME} is the hosted agent's name. Pick another.`);
      const types = b.types == null ? null : Array.isArray(b.types) && b.types.length && b.types.every((t) => TYPES.includes(t)) ? b.types : undefined;
      if (types === undefined) return fail('Types are bug, feature and task.');
      const pull = b.pull === true ? true : b.pull === false ? false : null;
      if ((await q(`SELECT 1 FROM cloud_agents WHERE project_id = $1 AND name = $2 AND revoked_at IS NULL`, [id, name])).length) return fail('An agent with that name is already connected.', 409);
      const token = `sca_${randomBytes(24).toString('hex')}`;
      const [a] = await q(
        `INSERT INTO cloud_agents (project_id, name, token_hash, owner_user_id, owner_name, pull, types) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, name`,
        [id, name, sha256(token), user.id, m.name, pull, types],
      );
      // The token is shown this once; only its hash is kept.
      return json({ agent: a, token }, 201);
    }
    return fail('Not found', 404);
  }

  /**
   * The hosted agent as a broadcaster (shipcue report 3d2dded6): a report assigned to it, or any new one
   * with auto-triage, is triaged after the response (background), so filing and assigning never wait on OpenAI.
   */
  async function hostedBroadcaster(p, store, config, forwarders) {
    if (!hosted || !p.hosted_agent) return [];
    const row = (await q(`SELECT id, name FROM cloud_agents WHERE project_id = $1 AND hosted AND revoked_at IS NULL`, [p.id]))[0];
    if (!row) return [];
    const agent = { kind: 'agent', id: row.id, name: row.name };
    return [
      {
        name: 'hosted agent',
        events: ['report.filed', 'report.assigned'],
        async send(e) {
          const assigned = e.type === 'report.assigned' && e.report.status === 'open' && e.report.claimantId === agent.id;
          if (!assigned && !(e.type === 'report.filed' && p.hosted_auto_triage)) return;
          const work = triageReport({
            store,
            reportId: e.report.id,
            agent,
            areas: config.areas,
            held: assigned,
            openai: hosted,
            candidates: hosted.duplicateCandidates,
            dailyLimit: hosted.dailyLimit,
            // The cap counts its notes in the last 24 hours.
            usedToday: async () =>
              Number(
                (
                  await q(
                    `SELECT count(*)::int AS n FROM shipcue_report_events WHERE project_id = $1 AND action = 'note' AND actor_id = $2 AND at > now() - interval '1 day'`,
                    [p.id, agent.id],
                  )
                )[0].n,
              ),
            onReleased: (r) => broadcast(forwarders, { type: 'report.released', at: new Date().toISOString(), report: r }),
          }).catch((err) => console.error('shipcue cloud: hosted agent failed', err));
          background(work);
        },
      },
    ];
  }

  /** The project's own shipcue handler: the button, the agent API and the team API. */
  async function projectQueue(req, key) {
    if (!/^pk_[0-9a-f]{24}$/.test(key)) return fail('Not found', 404);
    const p = (await q(`SELECT * FROM cloud_projects WHERE public_key = $1 AND NOT is_deleted`, [key]))[0];
    if (!p) return fail('Not found', 404);
    const path = new URL(req.url).pathname;
    const teamPath = path.startsWith(`${base}/p/${key}/team/`);
    if (teamPath && !jsonWrite(req)) return fail('Send JSON.', 415);
    // The button files a form, which browsers send cross-site without asking (no preflight), so CORS alone
    // would let any page file into the queue. A browser always names its page's origin: hold it to the list.
    const origin = req.headers.get('origin');
    const filing = req.method === 'POST' && (path === `${base}/p/${key}/reports` || /^\/reports\/[^/]+\/video$/.test(path.slice(`${base}/p/${key}`.length)));
    if (filing && origin && !p.allowed_origins.includes(origin)) return fail("This site is not on the project's list of sites.", 403);
    const s = teamPath ? await session(req) : null;
    const store = postgresStore(db, 'shipcue_reports', { project: p.id });
    const config = resolveConfig({ areas: Array.isArray(p.areas) ? p.areas : [] });
    // Each project's own forwarding: a Slack channel and/or a signed webhook.
    const forwarders = [
      ...(p.slack_webhook_url ? [slack({ webhookUrl: p.slack_webhook_url, events: p.notify_events })] : []),
      ...(p.webhook_url ? [webhook({ url: p.webhook_url, secret: p.webhook_secret ?? undefined, events: p.notify_events })] : []),
    ];
    const handler = createShipcueHandler({
      store,
      config,
      basePath: `${base}/p/${key}`,
      cors: p.allowed_origins,
      // The site vouches for who is signed in there; Cloud cannot check it.
      getReporter: async (r) => reporterFrom(r),
      board: p.public_board,
      // The team sees every fix link on the public board, private repositories included.
      boardAdmin: async (r) => {
        const sess = await session(r);
        return !!(sess && (await memberOf(p.id, sess.user.id)));
      },
      leaseSeconds: p.lease_seconds ?? undefined,
      broadcasters: [...forwarders, ...(await hostedBroadcaster(p, store, config, forwarders))],
      // POST {base}/p/<key>/github: PRs naming this project's reports move them (shipcue report 919f5ca2).
      github: p.github_secret ? { secret: p.github_secret } : undefined,
      agents: async (token) => {
        const a = (
          await q(
            `UPDATE cloud_agents SET last_seen_at = now() WHERE token_hash = $1 AND project_id = $2 AND revoked_at IS NULL AND NOT hosted RETURNING id, name, pull, types`,
            [sha256(token), p.id],
          )
        )[0];
        return a ? { id: a.id, name: a.name, pull: a.pull ?? p.agent_pull, types: a.types ?? undefined, leaseSeconds: p.lease_seconds ?? undefined } : null;
      },
      team: {
        getMember: async () => {
          if (!s) return null;
          const m = await memberOf(p.id, s.user.id);
          return m ? { id: m.user_id, name: m.name, role: m.role } : null;
        },
        claimants: async () => {
          const [members, agents] = await Promise.all([
            q(`SELECT user_id, name FROM cloud_members WHERE project_id = $1 AND NOT is_deleted AND role <> 'viewer' ORDER BY name`, [p.id]),
            q(`SELECT id, name FROM cloud_agents WHERE project_id = $1 AND revoked_at IS NULL ORDER BY name`, [p.id]),
          ]);
          return [...members.map((m) => ({ kind: 'person', id: m.user_id, name: m.name })), ...agents.map((a) => ({ kind: 'agent', id: a.id, name: a.name }))];
        },
      },
    });
    return withCookies(await handler(req), s?.set);
  }

  /** Where a project's digest goes: its Slack channel, or its first owner's email. Null when that is not set up. */
  async function digestSender(p) {
    if (p.digest_to === 'email') {
      if (!sendEmail) return null;
      const owner = (await q(`SELECT email FROM cloud_members WHERE project_id = $1 AND role = 'owner' AND NOT is_deleted ORDER BY created_at LIMIT 1`, [p.id]))[0];
      return owner ? emailDigest({ to: owner.email, send: sendEmail }) : null;
    }
    return p.slack_webhook_url ? slackDigest({ webhookUrl: p.slack_webhook_url }) : null;
  }

  /**
   * {base}/digest, for the cron (shipcue report 5f4d339b): sends every due digest and records the period
   * sent. A period is taken before it is sent, so two runs at once never send it twice; a failed send
   * gives it back for the next run.
   */
  async function runDigests(req) {
    if (!opts.cronSecret) return fail('Not found', 404);
    const given = Buffer.from(req.headers.get('authorization') ?? '');
    const expected = Buffer.from(`Bearer ${opts.cronSecret}`);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return fail('Unauthorized', 401);
    const now = new Date();
    const link = new URL(appPath, req.url).toString();
    const results = [];
    for (const p of await q(`SELECT * FROM cloud_projects WHERE digest_every <> 'off' AND NOT is_deleted ORDER BY digest_sent_at NULLS FIRST`)) {
      const due = digestDue(p, now);
      if (!due) continue;
      const taken = await q(`UPDATE cloud_projects SET digest_sent_at = $2 WHERE id = $1 AND digest_sent_at IS NOT DISTINCT FROM $3::timestamptz RETURNING id`, [p.id, due.until, p.digest_sent_at ?? null]);
      if (!taken.length) continue;
      try {
        const sender = await digestSender(p);
        if (!sender) {
          results.push({ project: p.id, sent: false, reason: 'no destination' });
          continue;
        }
        const message = await digest(postgresStore(db, 'shipcue_reports', { project: p.id }), { ...due, format: sender.format, appName: p.name, link });
        if (message.summary.empty) {
          results.push({ project: p.id, sent: false, reason: 'no activity' });
          continue;
        }
        await sender.send(message);
        results.push({ project: p.id, sent: true });
      } catch (err) {
        console.error('shipcue cloud: digest failed', p.id, err instanceof Error ? err.message : err);
        await q(`UPDATE cloud_projects SET digest_sent_at = $3::timestamptz WHERE id = $1 AND digest_sent_at = $2`, [p.id, due.until, p.digest_sent_at ?? null]);
        results.push({ project: p.id, sent: false, reason: 'failed' });
      }
    }
    return json({ sent: results.filter((r) => r.sent).length, results });
  }

  async function route(req) {
    const path = new URL(req.url).pathname;
    if (!path.startsWith(`${base}/`)) return fail('Not found', 404);
    const parts = path.slice(base.length + 1).split('/').filter(Boolean);
    const [head, ...rest] = parts;
    if (head === 'p' && rest[0]) return projectQueue(req, rest[0]);
    if (head === 'digest' && !rest.length && (req.method === 'GET' || req.method === 'POST')) return runDigests(req);
    if (!jsonWrite(req)) return fail('Send JSON.', 415);
    if (head === 'auth') return authRoutes(req, rest[0], rest[1]);
    const s = await session(req);
    if (!s) return fail('Sign in first.', 401);
    if (head === 'me' && req.method === 'GET') return withCookies(await me(s.user), s.set);
    if (head === 'overview' && req.method === 'GET' && !rest.length) return withCookies(await overview(s.user), s.set);
    if (head === 'overview' && req.method === 'GET' && rest[0] === 'versions' && rest.length === 1) return withCookies(await overviewVersions(s.user), s.set);
    if (head === 'projects') return withCookies(await projectRoutes(req, s.user, rest), s.set);
    return fail('Not found', 404);
  }

  return async function cloudHandler(req) {
    try {
      return await route(req);
    } catch (err) {
      console.error('shipcue cloud: failed', err);
      return fail('Something went wrong. Please try again.', 500);
    }
  };
}
