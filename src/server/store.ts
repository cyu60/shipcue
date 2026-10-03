import { ACTIVE_STATUSES, currentScope, describeScope, EDIT_FIELDS, sortQueue, toClaimant, type ActiveScope, type Claimant, type WorkScope, type ReportEdit, type Priority, type Report, type ReportEvent, type ReportEventAction, type ReportInput, type ReportType, type Status } from '../core';

export type NewReport = ReportInput & {
  reporter: string | null;
  screenshots: string[];
  /** Who sent it while signed out, as a keyed hash (never the address itself), for anonymousLimit. */
  clientKey?: string | null;
  /**
   * One per draft, the same on every retry of it (shipcue report 9833fd28). A store files a key
   * once per project; a repeat returns the report it filed, with `replayed: true`. Needs the
   * idempotency_key column ("Upgrading from 0.26" in sql/schema.sql); without it, no dedupe.
   */
  idempotencyKey?: string | null;
};
/** What create returns: the report, and `replayed: true` when its idempotencyKey was already filed (it is that first report). */
export type CreatedReport = Report & { replayed?: true };
export type ClosedStatus = Extract<Status, 'fixed' | 'wontfix'>;

export interface ListFilter {
  status?: Status;
  /** Only reports this claimant holds or has queued (a claimant id). */
  claimant?: string;
  /** Only reports filed by this reporter (the reporter portal, shipcue report 3d0d7995). */
  reporter?: string;
}

export interface ClaimOptions {
  /** Seconds until the claim runs out unless renewed with heartbeat. Leave out for no lease. */
  leaseSeconds?: number;
  /** What the work touches (shipcue report 83f5d976): kept on the claim's history event. */
  scope?: WorkScope | null;
}

export interface ClaimNextOptions extends ClaimOptions {
  /** Also take unassigned open reports (pull mode). True by default; false takes only assigned work. */
  pull?: boolean;
  /** Only these report types. */
  types?: ReportType[];
}

export interface HolderOptions {
  /** Only if this claimant id holds it (or nobody does). Agents with their own token pass their id. */
  holder?: string;
  /** Who is doing it, for the history. */
  by?: Claimant | null;
}

/** Where reports live. Every method returns null when the id is unknown or the move is not allowed. */
export interface ReportStore {
  /** Files a report. With an idempotencyKey it has seen (for this project), returns that report instead, with `replayed: true`. */
  create(input: NewReport): Promise<CreatedReport>;
  get(id: string): Promise<Report | null>;
  /** Queue order: most urgent first, oldest first within a priority. */
  list(filter?: ListFilter): Promise<Report[]>;
  /**
   * Atomically takes the next report for this claimant: one queued for them first, then (in pull
   * mode) the most urgent unassigned open report.
   */
  claimNext(who: string | Claimant, opts?: ClaimNextOptions): Promise<Report | null>;
  /** Takes an open report that is unassigned or queued for this claimant. */
  claim(id: string, who: string | Claimant, opts?: ClaimOptions): Promise<Report | null>;
  /** Back to the queue, unassigned. */
  release(id: string, opts?: HolderOptions): Promise<Report | null>;
  close(id: string, status: ClosedStatus, resolution: string | null, opts?: HolderOptions & { prUrl?: string | null }): Promise<Report | null>;
  /** Links a video to a report that has none yet. */
  attachVideo(id: string, url: string): Promise<Report | null>;
  /**
   * A short string that changes whenever any report is filed or changes, so a live board can
   * check it often and re-read only when it moves. Optional: without it the handler works it out
   * from the lists.
   */
  version?(): Promise<string>;

  // The CueLog's claim model. Optional so older custom stores keep working; the built-in stores have all of them.
  /**
   * Hands a report to a person (claimed by them) or queues it for an agent (open, theirs to take
   * next), or with null puts it back unassigned. Works on open and claimed reports.
   */
  assign?(id: string, to: Claimant | null, by?: Claimant | null): Promise<Report | null>;
  /** Renews the holder's lease. */
  heartbeat?(id: string, holder: string, leaseSeconds: number): Promise<Report | null>;
  /** A PR is up: in_review, with no lease, until it is closed. */
  review?(id: string, prUrl: string, opts?: HolderOptions): Promise<Report | null>;
  /** A closed or in-review report goes back to the queue, unassigned. */
  reopen?(id: string, by?: Claimant | null): Promise<Report | null>;
  setPriority?(id: string, priority: Priority, by?: Claimant | null): Promise<Report | null>;
  /** Releases every claim whose lease ran out, and returns those reports. */
  expire?(): Promise<Report[]>;
  /** A report's history, oldest first. */
  events?(id: string): Promise<ReportEvent[]>;
  /** How many signed-out reports came from this client key (see the handler's anonymousLimit). */
  countFromClient?(clientKey: string): Promise<number>;
  /**
   * Adds a note to a report's history (shipcue report 3d2dded6): a person, an agent or a hosted
   * agent saying something about it. The report itself only gets a new updatedAt. Null for an unknown id.
   * `extra` is kept beside the text in the event's detail, e.g. the hosted agent's `suggest` or a
   * merge's `mergedFrom` (shipcue report 1c0bf5be); it never replaces `text`.
   */
  note?(id: string, text: string, by?: Claimant | null, extra?: Record<string, unknown>): Promise<ReportEvent | null>;
  /**
   * Rewrites a filed report's text, type, area or what-changed line, in any status (shipcue
   * report 5c54da74). The history gets an 'edited' event naming the fields. Null for an unknown id.
   */
  edit?(id: string, patch: ReportEdit, by?: Claimant | null): Promise<Report | null>;
  /**
   * Changes the work area of a claimed or in-review report (shipcue report 83f5d976): a 'note' in
   * the history with the scope in its detail; null clears it. Null when the report is not held (by
   * opts.holder, when given).
   */
  setScope?(id: string, scope: WorkScope | null, opts?: HolderOptions): Promise<ReportEvent | null>;
  /** Every active claim (claimed or in review) with the scope it declared, in queue order. */
  scopes?(): Promise<ActiveScope[]>;
}

/** The fields an edit sets, in a fixed order, for the history. */
export const editedFields = (patch: ReportEdit) => EDIT_FIELDS.filter((f) => patch[f] !== undefined);

const holds = (r: Report, holder: string | undefined) => holder === undefined || r.claimantId == null || r.claimantId === holder;
const leaseUntil = (s: number | undefined) => (s === undefined ? null : new Date(Date.now() + s * 1000).toISOString());
const unclaimed = { claimedBy: null, claimedAt: null, claimantKind: null, claimantId: null, leaseExpiresAt: null } as const;

/** In-process store for tests, demos and prototypes. Lost on restart. */
export function memoryStore(): ReportStore {
  const rows = new Map<string, Report>();
  const log: ReportEvent[] = [];
  const clients = new Map<string, string>();
  const keys = new Map<string, string>();
  // Strictly increasing so reports filed in the same millisecond keep their order.
  let last = 0;
  const now = () => new Date((last = Math.max(Date.now(), last + 1))).toISOString();
  const record = (reportId: string, action: ReportEventAction, actor: Claimant | null | undefined, detail: Record<string, unknown> = {}) => {
    const e: ReportEvent = { id: crypto.randomUUID(), reportId, action, actor: actor ?? null, detail, at: now() };
    log.push(e);
    return e;
  };
  const update = (id: string, when: (r: Report) => boolean, patch: (r: Report) => Partial<Report>) => {
    const r = rows.get(id);
    if (!r || !when(r)) return null;
    const next = { ...r, ...patch(r), updatedAt: now() };
    rows.set(id, next);
    return { ...next };
  };
  const take = (id: string, c: Claimant, opts: ClaimOptions | undefined) => {
    const r = update(
      id,
      (r) => r.status === 'open' && (r.claimantId == null || r.claimantId === c.id),
      () => ({ status: 'claimed', claimedBy: c.name, claimedAt: now(), claimantKind: c.kind, claimantId: c.id, leaseExpiresAt: leaseUntil(opts?.leaseSeconds) }),
    );
    if (r) record(id, 'claimed', c, opts?.scope ? { scope: opts.scope } : {});
    return r;
  };

  return {
    async create(input) {
      const known = input.idempotencyKey ? keys.get(input.idempotencyKey) : undefined;
      if (known && rows.has(known)) return { ...rows.get(known)!, replayed: true };
      const r: Report = {
        ...input,
        context: input.context ?? null,
        id: crypto.randomUUID(),
        status: 'open',
        createdAt: now(),
        ...unclaimed,
        resolution: null,
        video: null,
        prUrl: null,
      };
      // Kept beside the report, never on it.
      delete (r as Partial<NewReport>).clientKey;
      delete (r as Partial<NewReport>).idempotencyKey;
      if (input.clientKey) clients.set(r.id, input.clientKey);
      if (input.idempotencyKey) keys.set(input.idempotencyKey, r.id);
      r.updatedAt = r.createdAt;
      rows.set(r.id, r);
      return { ...r };
    },
    async get(id) {
      const r = rows.get(id);
      return r ? { ...r } : null;
    },
    async list(filter = {}) {
      return sortQueue(
        [...rows.values()].filter((r) => (!filter.status || r.status === filter.status) && (!filter.claimant || r.claimantId === filter.claimant) && (!filter.reporter || r.reporter === filter.reporter)),
      );
    },
    async claimNext(who, opts = {}) {
      const c = toClaimant(who);
      const open = sortQueue([...rows.values()].filter((r) => r.status === 'open' && (!opts.types || opts.types.includes(r.type))));
      const top = open.find((r) => r.claimantId === c.id) ?? (opts.pull === false ? undefined : open.find((r) => r.claimantId == null));
      return top ? take(top.id, c, opts) : null;
    },
    async claim(id, who, opts) {
      return take(id, toClaimant(who), opts);
    },
    async release(id, opts = {}) {
      const r = update(id, (r) => (['claimed', 'in_review'].includes(r.status) || (r.status === 'open' && r.claimantId != null)) && holds(r, opts.holder), () => ({ status: 'open', ...unclaimed }));
      if (r) record(id, 'released', opts.by);
      return r;
    },
    async close(id, status, resolution, opts = {}) {
      const r = update(id, (r) => holds(r, opts.holder), (r) => ({ status, resolution, leaseExpiresAt: null, prUrl: opts.prUrl ?? r.prUrl ?? null }));
      if (r) record(id, 'closed', opts.by, { status });
      return r;
    },
    async attachVideo(id, url) {
      return update(id, (r) => r.video === null, () => ({ video: url }));
    },
    async version() {
      const latest = [...rows.values()].reduce((m, r) => ((r.updatedAt ?? r.createdAt) > m ? (r.updatedAt ?? r.createdAt) : m), '');
      return `${rows.size}:${latest}`;
    },
    async assign(id, to, by) {
      const r = update(
        id,
        (r) => r.status === 'open' || r.status === 'claimed',
        () =>
          to === null
            ? { status: 'open', ...unclaimed }
            : to.kind === 'person'
              ? { status: 'claimed', claimedBy: to.name, claimedAt: now(), claimantKind: 'person', claimantId: to.id, leaseExpiresAt: null }
              : { status: 'open', claimedBy: to.name, claimedAt: null, claimantKind: 'agent', claimantId: to.id, leaseExpiresAt: null },
      );
      if (r) record(id, 'assigned', by, { to });
      return r;
    },
    async heartbeat(id, holder, leaseSeconds) {
      return update(id, (r) => r.status === 'claimed' && r.claimantId === holder, () => ({ leaseExpiresAt: leaseUntil(leaseSeconds) }));
    },
    async review(id, prUrl, opts = {}) {
      const r = update(id, (r) => (r.status === 'claimed' || r.status === 'open') && holds(r, opts.holder), () => ({ status: 'in_review', prUrl, leaseExpiresAt: null }));
      if (r) record(id, 'review', opts.by, { prUrl });
      return r;
    },
    async reopen(id, by) {
      const r = update(id, (r) => ['fixed', 'wontfix', 'in_review'].includes(r.status), () => ({ status: 'open', ...unclaimed, resolution: null }));
      if (r) record(id, 'reopened', by);
      return r;
    },
    async setPriority(id, priority, by) {
      const r = update(id, () => true, () => ({ priority }));
      if (r) record(id, 'priority', by, { priority });
      return r;
    },
    async expire() {
      const at = Date.now();
      const out: Report[] = [];
      for (const r of rows.values()) {
        if (r.status !== 'claimed' || !r.leaseExpiresAt || Date.parse(r.leaseExpiresAt) >= at) continue;
        const was: Claimant | null = r.claimantKind && r.claimantId ? { kind: r.claimantKind, id: r.claimantId, name: r.claimedBy ?? r.claimantId } : null;
        const next = update(r.id, () => true, () => ({ status: 'open', ...unclaimed }))!;
        record(r.id, 'expired', was);
        out.push(next);
      }
      return out;
    },
    async events(id) {
      return log.filter((e) => e.reportId === id).map((e) => ({ ...e }));
    },
    async note(id, text, by, extra) {
      if (!update(id, () => true, () => ({}))) return null;
      return { ...record(id, 'note', by, { ...extra, text }) };
    },
    async edit(id, patch, by) {
      const fields = editedFields(patch);
      const set: Partial<Report> = {};
      for (const f of fields) Object.assign(set, { [f]: patch[f] });
      const r = update(id, () => true, () => set);
      if (r) record(id, 'edited', by, { fields });
      return r;
    },
    async setScope(id, scope, opts = {}) {
      if (!update(id, (r) => ACTIVE_STATUSES.includes(r.status) && holds(r, opts.holder), () => ({}))) return null;
      return { ...record(id, 'note', opts.by, { text: describeScope(scope), scope }) };
    },
    async scopes() {
      const active = sortQueue([...rows.values()].filter((r) => ACTIVE_STATUSES.includes(r.status)));
      return active.map((r) => ({ report: { ...r }, scope: currentScope(log.filter((e) => e.reportId === r.id)) }));
    },
    async countFromClient(clientKey) {
      return [...clients.entries()].filter(([id, k]) => k === clientKey && rows.has(id)).length;
    },
  };
}
