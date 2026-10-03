import type { Report } from '../core';
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
  resolution: string | null;
  video: string | null;
  context: string | null;
  created_at: Date | string;
  updated_at?: Date | string;
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
    resolution: r.resolution,
    video: r.video ?? null,
    context: r.context ?? null,
    updatedAt: iso(r.updated_at ?? r.created_at)!,
  };
}

const COLUMNS =
  'id, type, priority, area, description, page_url, user_agent, diagnostics, screenshots, reporter, status, claimed_by, claimed_at, resolution, video, context, created_at, updated_at';
const QUEUE_ORDER = 'ORDER BY priority_rank DESC, created_at, id';

export interface PostgresStoreOptions {
  /**
   * Keep to one project's reports: every read and write is limited to rows with this
   * project_id, and new reports get it. For a hosted queue serving many apps from one table
   * (shipcue Cloud); needs the project_id column from sql/cloud.sql. Leave out for one app.
   */
  project?: string;
}

/** Stores reports in the shipcue_reports table from sql/schema.sql. Use a server-side connection. */
export function postgresStore(db: Queryable, table = 'shipcue_reports', opts: PostgresStoreOptions = {}): ReportStore {
  if (!/^[a-z_][a-z0-9_.]*$/i.test(table)) throw new Error(`Bad table name: ${table}`);
  const project = opts.project;
  if (project !== undefined && !/^[0-9a-f-]{36}$/i.test(project)) throw new Error('project must be a uuid');
  const one = async (text: string, params: unknown[]) => {
    const { rows } = await db.query(text, params);
    return rows[0] ? toReport(rows[0] as Row) : null;
  };
  const many = async (text: string, params: unknown[]) => (await db.query(text, params)).rows.map((r) => toReport(r as Row));
  const isUuid = (id: string) => /^[0-9a-f-]{36}$/i.test(id);
  /** " AND project_id = $n" with the project added to params, or nothing for a one-app store. */
  const scope = (params: unknown[]) => {
    if (project === undefined) return '';
    params.push(project);
    return ` AND project_id = $${params.length}`;
  };

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
      if (project !== undefined) params.push(project);
      const r = await one(
        `INSERT INTO ${table} (type, priority, area, description, page_url, user_agent, diagnostics, screenshots, reporter, context${project !== undefined ? ', project_id' : ''})
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10${project !== undefined ? ', $11' : ''}) RETURNING ${COLUMNS}`,
        params,
      );
      return r!;
    },
    async get(id) {
      if (!isUuid(id)) return null;
      const params: unknown[] = [id];
      return one(`SELECT ${COLUMNS} FROM ${table} WHERE id = $1 AND NOT is_deleted${scope(params)}`, params);
    },
    async list(filter = {}) {
      const params: unknown[] = filter.status ? [filter.status] : [];
      const where = filter.status ? 'AND status = $1' : '';
      return many(`SELECT ${COLUMNS} FROM ${table} WHERE NOT is_deleted ${where}${scope(params)} ${QUEUE_ORDER}`, params);
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
    async claimNext(agent) {
      // SKIP LOCKED: two agents asking at once get two different reports.
      const params: unknown[] = [agent];
      return one(
        `UPDATE ${table} SET status = 'claimed', claimed_by = $1, claimed_at = now(), updated_at = now()
          WHERE id = (SELECT id FROM ${table} WHERE status = 'open' AND NOT is_deleted${scope(params)} ${QUEUE_ORDER} LIMIT 1 FOR UPDATE SKIP LOCKED)
          RETURNING ${COLUMNS}`,
        params,
      );
    },
    async claim(id, agent) {
      if (!isUuid(id)) return null;
      const params: unknown[] = [id, agent];
      return one(
        `UPDATE ${table} SET status = 'claimed', claimed_by = $2, claimed_at = now(), updated_at = now()
          WHERE id = $1 AND status = 'open' AND NOT is_deleted${scope(params)} RETURNING ${COLUMNS}`,
        params,
      );
    },
    async release(id) {
      if (!isUuid(id)) return null;
      const params: unknown[] = [id];
      return one(
        `UPDATE ${table} SET status = 'open', claimed_by = NULL, claimed_at = NULL, updated_at = now()
          WHERE id = $1 AND status = 'claimed' AND NOT is_deleted${scope(params)} RETURNING ${COLUMNS}`,
        params,
      );
    },
    async close(id, status, resolution) {
      if (!isUuid(id)) return null;
      const params: unknown[] = [id, status, resolution];
      return one(
        `UPDATE ${table} SET status = $2, resolution = $3, updated_at = now()
          WHERE id = $1 AND NOT is_deleted${scope(params)} RETURNING ${COLUMNS}`,
        params,
      );
    },
    async attachVideo(id, url) {
      if (!isUuid(id)) return null;
      const params: unknown[] = [id, url];
      return one(
        `UPDATE ${table} SET video = $2, updated_at = now()
          WHERE id = $1 AND video IS NULL AND NOT is_deleted${scope(params)} RETURNING ${COLUMNS}`,
        params,
      );
    },
  };
}
