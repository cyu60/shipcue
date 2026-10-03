import { sortQueue, toClaimant, type Claimant, type Priority, type Report, type ReportEvent, type ReportEventAction, type ReportInput, type ReportType, type Status } from '../core';

export type NewReport = ReportInput & {
  reporter: string | null;
  screenshots: string[];
  /** Who sent it while signed out, as a keyed hash (never the address itself), for anonymousLimit. */
  clientKey?: string | null;
};
export type ClosedStatus = Extract<Status, 'fixed' | 'wontfix'>;

export interface ListFilter {
  status?: Status;
  /** Only reports this claimant holds or has queued (a claimant id). */
  claimant?: string;
}

export interface ClaimOptions {
  /** Seconds until the claim runs out unless renewed with heartbeat. Leave out for no lease. */
  leaseSeconds?: number;
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
  create(input: NewReport): Promise<Report>;
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
}

const holds = (r: Report, holder: string | undefined) => holder === undefined || r.claimantId == null || r.claimantId === holder;
const leaseUntil = (s: number | undefined) => (s === undefined ? null : new Date(Date.now() + s * 1000).toISOString());
const unclaimed = { claimedBy: null, claimedAt: null, claimantKind: null, claimantId: null, leaseExpiresAt: null } as const;

/** In-process store for tests, demos and prototypes. Lost on restart. */
export function memoryStore(): ReportStore {
  const rows = new Map<string, Report>();
  const log: ReportEvent[] = [];
  const clients = new Map<string, string>();
  // Strictly increasing so reports filed in the same millisecond keep their order.
  let last = 0;
  const now = () => new Date((last = Math.max(Date.now(), last + 1))).toISOString();
  const record = (reportId: string, action: ReportEventAction, actor: Claimant | null | undefined, detail: Record<string, unknown> = {}) =>
    log.push({ id: crypto.randomUUID(), reportId, action, actor: actor ?? null, detail, at: now() });
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
    if (r) record(id, 'claimed', c);
    return r;
  };

  return {
    async create(input) {
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
      if (input.clientKey) clients.set(r.id, input.clientKey);
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
        [...rows.values()].filter((r) => (!filter.status || r.status === filter.status) && (!filter.claimant || r.claimantId === filter.claimant)),
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
    async countFromClient(clientKey) {
      return [...clients.entries()].filter(([id, k]) => k === clientKey && rows.has(id)).length;
    },
  };
}
