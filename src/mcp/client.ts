import type { ClaimConflict, ConflictReport, Priority, Report, ReportEvent, ReportType, Status, WorkScope } from '../core';

export interface AgentClientOptions {
  /** Where createShipcueHandler is mounted, e.g. https://app.example.com/api/shipcue */
  url: string;
  /** The agent token. Filing a report (file) works without one; the queue tools need it. */
  token?: string;
  /** Name stored as claimed_by, e.g. "claude-code@laptop". */
  agent?: string;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** The work area claims declare when the call gives none (e.g. from SHIPCUE_SCOPE; docs/swarm.md). */
  scope?: WorkScope | null;
}

/** A report an agent files for a person (shipcue report 9f533ece), the same fields the panel sends. */
export interface NewReport {
  type: ReportType;
  description: string;
  priority?: Priority;
  area?: string;
  pageUrl?: string;
  context?: string;
  /** The app snapshot as JSON text, as the panel would attach it. */
  diagnostics?: string;
  /** Who it is from, sent as x-shipcue-user (the handler's getReporter decides whether to use it). */
  reporter?: string;
  /** What to do when a host that dedupes finds a close match; without it the host answers LikelyDuplicateError. */
  ifDuplicate?: DuplicateChoice;
}

/**
 * The ways on from a close match, as hosts that dedupe read them (Habitect
 * report db7cb16c): add it to the match as a note, do that and reopen the
 * match if it is closed, or file it as a new report.
 */
export const DUPLICATE_CHOICES = ['addAsNote', 'reopen', 'fileAnyway'] as const;
export type DuplicateChoice = (typeof DUPLICATE_CHOICES)[number];

/** What filing answered: the new report, or the match it was added to as a note. */
export interface Filed {
  id: string;
  duplicateOf?: string;
  addedAsNote?: boolean;
  reopened?: boolean;
}

/** The report a host found close to the one being filed, as it describes it. */
export interface DuplicateMatch {
  id: string;
  status?: string;
  description?: string;
  resolution?: string | null;
}

/** A host answered 409 LIKELY_DUPLICATE: nothing was filed until the caller picks a DuplicateChoice. */
export class LikelyDuplicateError extends Error {
  readonly duplicateOf: string;
  readonly match: DuplicateMatch | null;
  readonly hint: string | null;
  constructor(body: { duplicateOf: string; match?: DuplicateMatch | null; hint?: string | null }) {
    super('LIKELY_DUPLICATE');
    this.name = 'LikelyDuplicateError';
    this.duplicateOf = body.duplicateOf;
    this.match = body.match ?? null;
    this.hint = body.hint ?? null;
  }
}

/** The close match and the ways on, for the agent to choose from. */
export function duplicateText(e: LikelyDuplicateError): string {
  const m = e.match;
  const status = m?.status ? ` (${m.status}${m.resolution ? `: ${m.resolution}` : ''})` : '';
  return [
    `Nothing filed: this looks like report ${e.duplicateOf}${status}.`,
    ...(m?.description ? [`It says: ${m.description}`] : []),
    ...(e.hint ? [e.hint] : []),
    `Call file_report again with if_duplicate: ${DUPLICATE_CHOICES.join(', ')}. Use addAsNote if it is the same, reopen if it was closed and is back, fileAnyway only if it is a different report.`,
  ].join('\n');
}

/** What filing did, in a sentence. */
export function filedText(f: Filed): string {
  if (!f.addedAsNote) return `Filed ${f.id}.`;
  return `Added as a note to ${f.id}, which it repeats${f.reopened ? ', and reopened it' : ''}.`;
}

/** The form fields a choice sends; fileAnyway sends force too, the name some hosts read. */
const choiceFields = (choice: DuplicateChoice | undefined): string[] =>
  choice === 'fileAnyway' ? ['fileAnyway', 'force'] : choice ? [choice] : [];

export interface Claimed {
  report: Report;
  prompt: string;
  /** Other active claims this one overlaps, when it declared a scope (shipcue report 83f5d976). */
  conflicts?: ClaimConflict[];
  /** The same in a sentence. Never a refusal: the claim went through. */
  warning?: string;
}

export interface ScopeSet {
  event: ReportEvent;
  scope: WorkScope | null;
  conflicts: ClaimConflict[];
  warning?: string;
}

/** Thin HTTP client for the agent API. The MCP tools are built on it. */
export function createAgentClient(opts: AgentClientOptions) {
  const base = opts.url.replace(/\/$/, '');
  const doFetch = opts.fetch ?? ((u: string, i?: RequestInit) => fetch(u, i));
  const agent = opts.agent ?? 'agent';
  const auth: Record<string, string> = opts.token ? { authorization: `Bearer ${opts.token}` } : {};

  async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T | null> {
    const res = await doFetch(`${base}/reports${path}`, {
      method: init.method ?? 'GET',
      headers: { ...auth, 'content-type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if (res.status === 204) return null;
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(body.error ?? `shipcue responded ${res.status}`);
    return body as T;
  }
  const post = <T>(path: string, body: unknown = {}) => call<T>(path, { method: 'POST', body });
  const withScope = (scope: WorkScope | null | undefined) => {
    const s = scope === undefined ? opts.scope : scope;
    return s ? { scope: s } : {};
  };

  return {
    /**
     * File a report the way the panel does: a multipart POST to {url}/reports. Run from the
     * agent's machine, so the handler's browser CORS rules do not apply; its sign-in and
     * anonymous limits still do. Needs no token, but sends it when there is one. It says it
     * can answer a close match (canConfirm), so a host that dedupes answers LikelyDuplicateError
     * instead of filing a duplicate; ifDuplicate is the answer.
     */
    async file(r: NewReport): Promise<Filed> {
      const form = new FormData();
      form.set('type', r.type);
      form.set('description', r.description);
      form.set('priority', r.priority ?? 'medium');
      form.set('area', r.area ?? 'other');
      form.set('pageUrl', r.pageUrl ?? '');
      form.set('context', r.context ?? '');
      form.set('userAgent', `shipcue-mcp (${agent})`);
      if (r.diagnostics) form.set('diagnostics', r.diagnostics);
      form.set('canConfirm', '1');
      for (const field of choiceFields(r.ifDuplicate)) form.set(field, '1');
      const res = await doFetch(`${base}/reports`, { method: 'POST', body: form, headers: { ...auth, ...(r.reporter ? { 'x-shipcue-user': r.reporter } : {}) } });
      const body = (await res.json().catch(() => ({}))) as Partial<Filed> & { error?: string; match?: DuplicateMatch; hint?: string };
      if (body.error === 'LIKELY_DUPLICATE' && body.duplicateOf) throw new LikelyDuplicateError({ duplicateOf: body.duplicateOf, match: body.match, hint: body.hint });
      if (!res.ok || !body.id) throw new Error(body.error ?? `shipcue responded ${res.status}`);
      const { id, duplicateOf, addedAsNote, reopened } = body;
      return { id, ...(duplicateOf ? { duplicateOf } : {}), ...(addedAsNote ? { addedAsNote, reopened: reopened === true } : {}) };
    },
    async list(status?: Status): Promise<Report[]> {
      const q = status ? `?status=${encodeURIComponent(status)}` : '';
      return (await call<{ reports: Report[] }>(q))!.reports;
    },
    /** What this agent holds or has queued for it. */
    async mine(): Promise<Report[]> {
      return (await call<{ reports: Report[] }>(`?mine=1&agent=${encodeURIComponent(agent)}`))!.reports;
    },
    async events(id: string): Promise<ReportEvent[]> {
      return (await call<{ events: ReportEvent[] }>(`/${encodeURIComponent(id)}/events`))!.events;
    },
    async get(id: string): Promise<Claimed> {
      return (await call<Claimed>(`/${encodeURIComponent(id)}`))!;
    },
    /** Takes the next report; a scope (or the client's default) says what the work will touch. */
    claimNext: (scope?: WorkScope | null): Promise<Claimed | null> => post<Claimed>('/next/claim', { agent, ...withScope(scope) }),
    async claim(id: string, scope?: WorkScope | null): Promise<Claimed> {
      return (await post<Claimed>(`/${encodeURIComponent(id)}/claim`, { agent, ...withScope(scope) }))!;
    },
    /** Changes what a report this agent holds touches; null clears it. */
    async setScope(id: string, scope: WorkScope | null): Promise<ScopeSet> {
      return (await post<ScopeSet>(`/${encodeURIComponent(id)}/scope`, { agent, scope }))!;
    },
    /** Active claims whose work areas overlap, and whether the queue is free (nothing claimed or in review). */
    async conflicts(): Promise<ConflictReport> {
      return (await call<ConflictReport>('/conflicts'))!;
    },
    async release(id: string): Promise<Report> {
      return (await post<{ report: Report }>(`/${encodeURIComponent(id)}/release`))!.report;
    },
    async close(id: string, status: 'fixed' | 'wontfix', resolution?: string, prUrl?: string): Promise<Report> {
      return (await post<{ report: Report }>(`/${encodeURIComponent(id)}/close`, { status, resolution, prUrl }))!.report;
    },
    /** Renews this agent's lease on a report it holds. */
    async heartbeat(id: string): Promise<Report> {
      return (await post<{ report: Report }>(`/${encodeURIComponent(id)}/heartbeat`))!.report;
    },
    /** Adds a note to the report's history, under this agent's name (shipcue report 3d2dded6). */
    async note(id: string, text: string): Promise<ReportEvent> {
      return (await post<{ event: ReportEvent }>(`/${encodeURIComponent(id)}/note`, { text, agent }))!.event;
    },
    /** Closes this report as a duplicate of `into`, with a note on both (shipcue report 1c0bf5be). */
    async merge(id: string, into: string): Promise<Report> {
      return (await post<{ report: Report }>(`/${encodeURIComponent(id)}/merge`, { into, agent }))!.report;
    },
    /** A PR is up: the report goes to in review. */
    async review(id: string, prUrl: string): Promise<Report> {
      return (await post<{ report: Report }>(`/${encodeURIComponent(id)}/review`, { prUrl }))!.report;
    },
  };
}

export type AgentClient = ReturnType<typeof createAgentClient>;
