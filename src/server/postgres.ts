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
  created_at: Date | string;
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
  };
}

const COLUMNS =
  'id, type, priority, area, description, page_url, user_agent, diagnostics, screenshots, reporter, status, claimed_by, claimed_at, resolution, created_at';
const QUEUE_ORDER = 'ORDER BY priority_rank DESC, created_at, id';

/** Stores reports in the shipcue_reports table from sql/schema.sql. Use a server-side connection. */
export function postgresStore(db: Queryable, table = 'shipcue_reports'): ReportStore {
  if (!/^[a-z_][a-z0-9_.]*$/i.test(table)) throw new Error(`Bad table name: ${table}`);
  const one = async (text: string, params: unknown[]) => {
    const { rows } = await db.query(text, params);
    return rows[0] ? toReport(rows[0] as Row) : null;
  };
  const many = async (text: string, params: unknown[]) => (await db.query(text, params)).rows.map((r) => toReport(r as Row));
  const isUuid = (id: string) => /^[0-9a-f-]{36}$/i.test(id);

  return {
    async create(input) {
      const r = await one(
        `INSERT INTO ${table} (type, priority, area, description, page_url, user_agent, diagnostics, screenshots, reporter)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9) RETURNING ${COLUMNS}`,
        [
          input.type,
          input.priority,
          input.area,
          input.description,
          input.pageUrl,
          input.userAgent,
          JSON.stringify(input.diagnostics),
          input.screenshots,
          input.reporter,
        ],
      );
      return r!;
    },
    async get(id) {
      if (!isUuid(id)) return null;
      return one(`SELECT ${COLUMNS} FROM ${table} WHERE id = $1 AND NOT is_deleted`, [id]);
    },
    async list(filter = {}) {
      return filter.status
        ? many(`SELECT ${COLUMNS} FROM ${table} WHERE NOT is_deleted AND status = $1 ${QUEUE_ORDER}`, [filter.status])
        : many(`SELECT ${COLUMNS} FROM ${table} WHERE NOT is_deleted ${QUEUE_ORDER}`, []);
    },
    async claimNext(agent) {
      // SKIP LOCKED: two agents asking at once get two different reports.
      return one(
        `UPDATE ${table} SET status = 'claimed', claimed_by = $1, claimed_at = now(), updated_at = now()
          WHERE id = (SELECT id FROM ${table} WHERE status = 'open' AND NOT is_deleted ${QUEUE_ORDER} LIMIT 1 FOR UPDATE SKIP LOCKED)
          RETURNING ${COLUMNS}`,
        [agent],
      );
    },
    async claim(id, agent) {
      if (!isUuid(id)) return null;
      return one(
        `UPDATE ${table} SET status = 'claimed', claimed_by = $2, claimed_at = now(), updated_at = now()
          WHERE id = $1 AND status = 'open' AND NOT is_deleted RETURNING ${COLUMNS}`,
        [id, agent],
      );
    },
    async release(id) {
      if (!isUuid(id)) return null;
      return one(
        `UPDATE ${table} SET status = 'open', claimed_by = NULL, claimed_at = NULL, updated_at = now()
          WHERE id = $1 AND status = 'claimed' AND NOT is_deleted RETURNING ${COLUMNS}`,
        [id],
      );
    },
    async close(id, status, resolution) {
      if (!isUuid(id)) return null;
      return one(
        `UPDATE ${table} SET status = $2, resolution = $3, updated_at = now()
          WHERE id = $1 AND NOT is_deleted RETURNING ${COLUMNS}`,
        [id, status, resolution],
      );
    },
  };
}
