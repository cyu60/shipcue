import { sortQueue, type Report, type ReportInput, type Status } from '../core';

export type NewReport = ReportInput & { reporter: string | null; screenshots: string[] };
export type ClosedStatus = Extract<Status, 'fixed' | 'wontfix'>;

/** Where reports live. Every method returns null when the id is unknown or the move is not allowed. */
export interface ReportStore {
  create(input: NewReport): Promise<Report>;
  get(id: string): Promise<Report | null>;
  /** Queue order: most urgent first, oldest first within a priority. */
  list(filter?: { status?: Status }): Promise<Report[]>;
  /** Atomically takes the most urgent open report. */
  claimNext(agent: string): Promise<Report | null>;
  claim(id: string, agent: string): Promise<Report | null>;
  release(id: string): Promise<Report | null>;
  close(id: string, status: ClosedStatus, resolution: string | null): Promise<Report | null>;
}

/** In-process store for tests, demos and prototypes. Lost on restart. */
export function memoryStore(): ReportStore {
  const rows = new Map<string, Report>();
  // Strictly increasing so reports filed in the same millisecond keep their order.
  let last = 0;
  const now = () => new Date((last = Math.max(Date.now(), last + 1))).toISOString();
  const update = (id: string, when: (r: Report) => boolean, patch: (r: Report) => Partial<Report>) => {
    const r = rows.get(id);
    if (!r || !when(r)) return null;
    const next = { ...r, ...patch(r) };
    rows.set(id, next);
    return { ...next };
  };
  return {
    async create(input) {
      const r: Report = {
        ...input,
        id: crypto.randomUUID(),
        status: 'open',
        createdAt: now(),
        claimedBy: null,
        claimedAt: null,
        resolution: null,
      };
      rows.set(r.id, r);
      return { ...r };
    },
    async get(id) {
      const r = rows.get(id);
      return r ? { ...r } : null;
    },
    async list(filter = {}) {
      return sortQueue([...rows.values()].filter((r) => !filter.status || r.status === filter.status));
    },
    async claimNext(agent) {
      const top = sortQueue([...rows.values()].filter((r) => r.status === 'open'))[0];
      return top ? this.claim(top.id, agent) : null;
    },
    async claim(id, agent) {
      return update(id, (r) => r.status === 'open', () => ({ status: 'claimed', claimedBy: agent, claimedAt: now() }));
    },
    async release(id) {
      return update(id, (r) => r.status === 'claimed', () => ({ status: 'open', claimedBy: null, claimedAt: null }));
    },
    async close(id, status, resolution) {
      return update(id, () => true, () => ({ status, resolution }));
    },
  };
}
