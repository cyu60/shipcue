// shipcue Cloud: projects, teams, invites and agents on top of the package's handler. Each project's
// queue lives in the shared shipcue_reports table under its project_id, served at
// {base}/p/<public key>/... with the same routes as a self-hosted handler (button, agent API, team API).
// Sign-in is InsForge auth on shipcue's project, kept server-side in httpOnly cookies.
import { createHash, randomBytes } from 'node:crypto';
import { createShipcueHandler, postgresStore } from '../../src/server';
import { resolveConfig } from '../../src/core';

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

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
const fail = (error, status = 400) => json({ error }, status);
const sha256 = (t) => createHash('sha256').update(t).digest('hex');
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

/**
 * @param {{ db: { query(text: string, params?: unknown[]): Promise<{ rows: any[] }> }, auth: ReturnType<typeof insforgeAuth>,
 *   base?: string, beta?: string[], secureCookies?: boolean, refreshDays?: number, cookiePath?: string, appPath?: string }} opts
 *   appPath: where Continue with Google lands, signed in or with ?error= (default /app/).
 *   beta: emails that may create projects during the invite-only beta. Everyone else joins by invite.
 */
export function createCloudHandler(opts) {
  const { db, auth } = opts;
  const base = (opts.base ?? '/api/cloud').replace(/\/$/, '');
  const beta = new Set((opts.beta ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean));
  const secure = opts.secureCookies !== false;
  const refreshDays = opts.refreshDays ?? 30;
  const q = async (text, params = []) => (await db.query(text, params)).rows;

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
        q(`SELECT id, name, owner_user_id, owner_name, pull, types, last_seen_at, created_at FROM cloud_agents WHERE project_id = $1 AND revoked_at IS NULL ORDER BY created_at`, [id]),
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
      });
    }
    if (req.method !== 'POST') return fail('Not found', 404);
    const b = await body(req);

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
      if (!sets.length) return fail('Nothing to change.');
      const [row] = await q(`UPDATE cloud_projects SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, params);
      return json({ project: publicProject(row) });
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
        const a = (await q(`SELECT owner_user_id FROM cloud_agents WHERE id = $1 AND project_id = $2 AND revoked_at IS NULL`, [subId, id]))[0];
        if (!a) return fail('Not found', 404);
        if (!owner && a.owner_user_id !== user.id) return fail('Only an owner or whoever connected it can disconnect it.', 403);
        await q(`UPDATE cloud_agents SET revoked_at = now() WHERE id = $1`, [subId]);
        return json({ ok: true });
      }
      const name = String(b.name ?? '').trim().toLowerCase();
      if (!AGENT_NAME.test(name)) return fail('Agent names are lowercase letters, numbers and . _ @ - (up to 60).');
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
    const handler = createShipcueHandler({
      store: postgresStore(db, 'shipcue_reports', { project: p.id }),
      config: resolveConfig({ areas: Array.isArray(p.areas) ? p.areas : [] }),
      basePath: `${base}/p/${key}`,
      cors: p.allowed_origins,
      board: p.public_board,
      // The team sees every fix link on the public board, private repositories included.
      boardAdmin: async (r) => {
        const sess = await session(r);
        return !!(sess && (await memberOf(p.id, sess.user.id)));
      },
      leaseSeconds: p.lease_seconds ?? undefined,
      agents: async (token) => {
        const a = (
          await q(
            `UPDATE cloud_agents SET last_seen_at = now() WHERE token_hash = $1 AND project_id = $2 AND revoked_at IS NULL RETURNING id, name, pull, types`,
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

  async function route(req) {
    const path = new URL(req.url).pathname;
    if (!path.startsWith(`${base}/`)) return fail('Not found', 404);
    const parts = path.slice(base.length + 1).split('/').filter(Boolean);
    const [head, ...rest] = parts;
    if (head === 'p' && rest[0]) return projectQueue(req, rest[0]);
    if (!jsonWrite(req)) return fail('Send JSON.', 415);
    if (head === 'auth') return authRoutes(req, rest[0], rest[1]);
    const s = await session(req);
    if (!s) return fail('Sign in first.', 401);
    if (head === 'me' && req.method === 'GET') return withCookies(await me(s.user), s.set);
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
