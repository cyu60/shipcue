import { toClaimant, type Claimant, type ClaimantKind, type Report, type ReportEvent, type ReportEventAction } from '../core';
import type { ReportStore } from './store';

/** Anything with a pg-style query: node-postgres Pool/Client, PGlite, Neon, Vercel Postgres. */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

interface Row {
  id: string;
  type: Report['type'];
  priority: Report['priority'];
  area: string;
  description: string;
  page_url: string;
  user_agent: string;
  diagnostics: Record<string, unknown> | string;
  screenshots: string[];
  reporter: string | null;
  status: Report['status'];
  claimed_by: string | null;
  claimed_at: Date | string | null;
  claimant_kind: ClaimantKind | null;
  claimant_id: string | null;
  lease_expires_at: Date | string | null;
  pr_url: string | null;
  resolution: string | null;
  video: string | null;
  context: string | null;
  created_at: Date | string;
  updated_at?: Date | string;
}

interface EventRow {
  id: string;
  report_id: string;
  action: ReportEventAction;
  actor_kind: ClaimantKind | null;
  actor_id: string | null;
  actor_name: string | null;
  detail: Record<string, unknown> | string;
  at: Date | string;
}

const iso = (v: Date | string | null) => (v === null ? null : new Date(v).toISOString());

function toReport(r: Row): Report {
  return {
    id: r.id,
    type: r.type,
    priority: r.priority,
    area: r.area,
    description: r.description,
    pageUrl: r.page_url,
    userAgent: r.user_agent,
    diagnostics: typeof r.diagnostics === 'string' ? JSON.parse(r.diagnostics) : r.diagnostics,
    screenshots: r.screenshots,
    reporter: r.reporter,
    status: r.status,
    createdAt: iso(r.created_at)!,
    claimedBy: r.claimed_by,
    claimedAt: iso(r.claimed_at),
    claimantKind: r.claimant_kind ?? null,
    claimantId: r.claimant_id ?? null,
    leaseExpiresAt: iso(r.lease_expires_at ?? null),
    prUrl: r.pr_url ?? null,
    resolution: r.resolution,
    video: r.video ?? null,
    context: r.context ?? null,
    updatedAt: iso(r.updated_at ?? r.created_at)!,
  };
}

function toEvent(e: EventRow): ReportEvent {
  return {
    id: e.id,
    reportId: e.report_id,
    action: e.action,
    actor: e.actor_kind && e.actor_id ? { kind: e.actor_kind, id: e.actor_id, name: e.actor_name ?? e.actor_id } : null,
    detail: typeof e.detail === 'string' ? JSON.parse(e.detail) : e.detail,
    at: iso(e.at)!,
  };
}

const COLUMNS =
  'id, type, priority, area, description, page_url, user_agent, diagnostics, screenshots, reporter, status, claimed_by, claimed_at, claimant_kind, claimant_id, lease_expires_at, pr_url, resolution, video, context, created_at, updated_at';
const QUEUE_ORDER = 'ORDER BY priority_rank DESC, created_at, id';
const UNCLAIMED = 'claimed_by = NULL, claimed_at = NULL, claimant_kind = NULL, claimant_id = NULL, lease_expires_at = NULL';
const NAME = /^[a-z_][a-z0-9_.]*$/i;

export interface PostgresStoreOptions {
  /**
   * Keep to one project's reports: every read and write is limited to rows with this
   * project_id, and new reports get it. For a hosted queue serving many apps from one table
   * (shipcue Cloud); needs the project_id column from sql/cloud.sql. Leave out for one app.
   * null: the table also holds Cloud projects' reports, and this store is the app's own queue,
   * so it only ever sees rows with no project.
   */
  project?: string | null;
  /** Where each report's history goes (sql/schema.sql makes it). */
  eventsTable?: string;
}

/** Stores reports in the shipcue_reports table from sql/schema.sql. Use a server-side connection. */
export function postgresStore(db: Queryable, table = 'shipcue_reports', opts: PostgresStoreOptions = {}): ReportStore {
  const events = opts.eventsTable ?? 'shipcue_report_events';
  if (!NAME.test(table)) throw new Error(`Bad table name: ${table}`);
  if (!NAME.test(events)) throw new Error(`Bad table name: ${events}`);
  const project = opts.project;
  if (project != null && !/^[0-9a-f-]{36}$/i.test(project)) throw new Error('project must be a uuid');
  const one = async (text: string, params: unknown[]) => {
    const { rows } = await db.query(text, params);
    return rows[0] ? toReport(rows[0] as Row) : null;
  };
  const many = async (text: string, params: unknown[]) => (await db.query(text, params)).rows.map((r) => toReport(r as Row));
  const isUuid = (id: string) => /^[0-9a-f-]{36}$/i.test(id);
  const p = (params: unknown[], v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  /** " AND project_id = $n" with the project added to params, or nothing for a one-app store. */
  const scope = (params: unknown[]) => (project === undefined ? '' : project === null ? ' AND project_id IS NULL' : ` AND project_id = ${p(params, project)}`);
  /** " AND (nobody or this claimant holds it)", when a holder is given. */
  const holds = (params: unknown[], holder: string | undefined) =>
    holder === undefined ? '' : ` AND (claimant_id IS NULL OR claimant_id = ${p(params, holder)})`;
  const lease = (params: unknown[], seconds: number | undefined) =>
    seconds === undefined ? 'NULL' : `now() + (${p(params, seconds)}::float8 * interval '1 second')`;
  const claimSet = (params: unknown[], c: Claimant, seconds: number | undefined) =>
    `status = 'claimed', claimed_by = ${p(params, c.name)}, claimed_at = now(), claimant_kind = ${p(params, c.kind)}, claimant_id = ${p(params, c.id)}, lease_expires_at = ${lease(params, seconds)}`;

  /** One UPDATE on one project's live rows; with an action, the change goes in the history in the same statement. */
  async function mutate(
    params: unknown[],
    set: string,
    where: string,
    event?: { action: ReportEventAction; actor?: Claimant | null; detail?: Record<string, unknown> },
  ): Promise<Report | null> {
    const update = `UPDATE ${table} SET ${set}, updated_at = now() WHERE ${where} AND NOT is_deleted${scope(params)} RETURNING *`;
    if (!event) return one(`WITH r AS (${update}) SELECT ${COLUMNS} FROM r`, params);
    const a = event.actor ?? null;
    const values = [
      'id',
      project == null ? 'NULL::uuid' : `${p(params, project)}::uuid`,
      p(params, event.action),
      p(params, a?.kind ?? null),
      p(params, a?.id ?? null),
      p(params, a?.name ?? null),
      `${p(params, JSON.stringify(event.detail ?? {}))}::jsonb`,
    ].join(', ');
    return one(
      `WITH r AS (${update}),
            e AS (INSERT INTO ${events} (report_id, project_id, action, actor_kind, actor_id, actor_name, detail) SELECT ${values} FROM r)
       SELECT ${COLUMNS} FROM r`,
      params,
    );
  }

  return {
    async create(input) {
      const params: unknown[] = [
        input.type,
        input.priority,
        input.area,
        input.description,
        input.pageUrl,
        input.userAgent,
        JSON.stringify(input.diagnostics),
        input.screenshots,
        input.reporter,
        input.context ?? null,
      ];
      const cols = ['type', 'priority', 'area', 'description', 'page_url', 'user_agent', 'diagnostics', 'screenshots', 'reporter', 'context'];
      if (project != null) {
        params.push(project);
        cols.push('project_id');
      }
      // Only when the handler limits signed-out reports (needs client_key, "Upgrading from 0.13").
      if (input.clientKey) {
        params.push(input.clientKey);
        cols.push('client_key');
      }
      const values = cols.map((c, i) => (c === 'diagnostics' ? `$${i + 1}::jsonb` : `$${i + 1}`)).join(', ');
      const r = await one(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${values}) RETURNING ${COLUMNS}`, params);
      return r!;
    },
    async get(id) {
      if (!isUuid(id)) return null;
      const params: unknown[] = [id];
      return one(`SELECT ${COLUMNS} FROM ${table} WHERE id = $1 AND NOT is_deleted${scope(params)}`, params);
    },
    async list(filter = {}) {
      const params: unknown[] = [];
      const where = (filter.status ? ` AND status = ${p(params, filter.status)}` : '') + (filter.claimant ? ` AND claimant_id = ${p(params, filter.claimant)}` : '');
      return many(`SELECT ${COLUMNS} FROM ${table} WHERE NOT is_deleted${where}${scope(params)} ${QUEUE_ORDER}`, params);
    },
    async version() {
      // One cheap row: how many reports, and when the last one changed.
      const params: unknown[] = [];
      const { rows } = await db.query(
        `SELECT count(*)::text AS n, coalesce(max(updated_at), max(created_at))::text AS at FROM ${table} WHERE NOT is_deleted${scope(params)}`,
        params,
      );
      const r = (rows[0] ?? {}) as { n?: string; at?: string | null };
      return `${r.n ?? 0}:${r.at ?? ''}`;
    },
    async claimNext(who, o = {}) {
      const c = toClaimant(who);
      const params: unknown[] = [];
      const set = claimSet(params, c, o.leaseSeconds);
      const me = p(params, c.id);
      const mine = o.pull === false ? `claimant_id = ${me}` : `(claimant_id = ${me} OR claimant_id IS NULL)`;
      const types = o.types ? ` AND type = ANY(${p(params, o.types)}::text[])` : '';
      // Queued for this claimant first, then queue order. SKIP LOCKED: two agents asking at once get two different reports.
      const next = `SELECT id FROM ${table} WHERE status = 'open' AND ${mine}${types} AND NOT is_deleted${scope(params)}
        ORDER BY (claimant_id IS NOT NULL) DESC, priority_rank DESC, created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`;
      return mutate(params, set, `id = (${next})`, { action: 'claimed', actor: c });
    },
    async claim(id, who, o = {}) {
      if (!isUuid(id)) return null;
      const c = toClaimant(who);
      const params: unknown[] = [];
      const set = claimSet(params, c, o.leaseSeconds);
      return mutate(params, set, `id = ${p(params, id)} AND status = 'open' AND (claimant_id IS NULL OR claimant_id = ${p(params, c.id)})`, { action: 'claimed', actor: c });
    },
    async release(id, o = {}) {
      if (!isUuid(id)) return null;
      const params: unknown[] = [];
      const where = `id = ${p(params, id)} AND (status IN ('claimed', 'in_review') OR (status = 'open' AND claimant_id IS NOT NULL))${holds(params, o.holder)}`;
      return mutate(params, `status = 'open', ${UNCLAIMED}`, where, { action: 'released', actor: o.by });
    },
    async close(id, status, resolution, o = {}) {
      if (!isUuid(id)) return null;
      const params: unknown[] = [];
      const set = `status = ${p(params, status)}, resolution = ${p(params, resolution)}, lease_expires_at = NULL, pr_url = coalesce(${p(params, o.prUrl ?? null)}, pr_url)`;
      return mutate(params, set, `id = ${p(params, id)}${holds(params, o.holder)}`, { action: 'closed', actor: o.by, detail: { status } });
    },
    async attachVideo(id, url) {
      if (!isUuid(id)) return null;
      const params: unknown[] = [];
      return mutate(params, `video = ${p(params, url)}`, `id = ${p(params, id)} AND video IS NULL`);
    },
    async assign(id, to, by) {
      if (!isUuid(id)) return null;
      const params: unknown[] = [];
      const set =
        to === null
          ? `status = 'open', ${UNCLAIMED}`
          : to.kind === 'person'
            ? claimSet(params, to, undefined)
            : `status = 'open', claimed_by = ${p(params, to.name)}, claimed_at = NULL, claimant_kind = 'agent', claimant_id = ${p(params, to.id)}, lease_expires_at = NULL`;
      return mutate(params, set, `id = ${p(params, id)} AND status IN ('open', 'claimed')`, { action: 'assigned', actor: by, detail: { to } });
    },
    async heartbeat(id, holder, leaseSeconds) {
      if (!isUuid(id)) return null;
      const params: unknown[] = [];
      const set = `lease_expires_at = ${lease(params, leaseSeconds)}`;
      return mutate(params, set, `id = ${p(params, id)} AND status = 'claimed' AND claimant_id = ${p(params, holder)}`);
    },
    async review(id, prUrl, o = {}) {
      if (!isUuid(id)) return null;
      const params: unknown[] = [];
      const set = `status = 'in_review', pr_url = ${p(params, prUrl)}, lease_expires_at = NULL`;
      return mutate(params, set, `id = ${p(params, id)} AND status IN ('claimed', 'open')${holds(params, o.holder)}`, { action: 'review', actor: o.by, detail: { prUrl } });
    },
    async reopen(id, by) {
      if (!isUuid(id)) return null;
      const params: unknown[] = [];
      return mutate(params, `status = 'open', ${UNCLAIMED}, resolution = NULL`, `id = ${p(params, id)} AND status IN ('fixed', 'wontfix', 'in_review')`, {
        action: 'reopened',
        actor: by,
      });
    },
    async setPriority(id, priority, by) {
      if (!isUuid(id)) return null;
      const params: unknown[] = [];
      return mutate(params, `priority = ${p(params, priority)}`, `id = ${p(params, id)}`, { action: 'priority', actor: by, detail: { priority } });
    },
    async expire() {
      // The holder whose lease ran out is kept on the history line.
      const params: unknown[] = [];
      const proj = project == null ? 'NULL::uuid' : `${p(params, project)}::uuid`;
      const { rows } = await db.query(
        `WITH old AS (SELECT id, claimant_kind, claimant_id, claimed_by FROM ${table}
                       WHERE status = 'claimed' AND lease_expires_at < now() AND NOT is_deleted${scope(params)} FOR UPDATE SKIP LOCKED),
              r AS (UPDATE ${table} AS x SET status = 'open', ${UNCLAIMED}, updated_at = now() FROM old WHERE x.id = old.id
                    RETURNING x.*, old.claimant_kind AS was_kind, old.claimant_id AS was_id, old.claimed_by AS was_name),
              e AS (INSERT INTO ${events} (report_id, project_id, action, actor_kind, actor_id, actor_name)
                    SELECT id, ${proj}, 'expired', was_kind, was_id, was_name FROM r)
         SELECT ${COLUMNS} FROM r`,
        params,
      );
      return rows.map((r) => toReport(r as Row));
    },
    async countFromClient(clientKey) {
      const params: unknown[] = [clientKey];
      const { rows } = await db.query(
        `SELECT count(*)::int AS n FROM ${table} WHERE client_key = $1 AND reporter IS NULL AND NOT is_deleted${scope(params)}`,
        params,
      );
      return Number((rows[0] as { n?: number } | undefined)?.n ?? 0);
    },
    async events(id) {
      if (!isUuid(id)) return [];
      const params: unknown[] = [id];
      const where = project === undefined ? '' : project === null ? ' AND project_id IS NULL' : ` AND project_id = ${p(params, project)}`;
      const { rows } = await db.query(
        `SELECT id, report_id, action, actor_kind, actor_id, actor_name, detail, at FROM ${events} WHERE report_id = $1${where} ORDER BY at, id`,
        params,
      );
      return rows.map((e) => toEvent(e as EventRow));
    },
  };
}
