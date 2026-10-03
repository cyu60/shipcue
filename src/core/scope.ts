// Work-area claims (shipcue report 83f5d976, docs/swarm.md): what a claim says it touches, and
// which active claims overlap. Pure functions, shared by the stores, the handler and the CueLog.
import type { Report, ReportEvent, ReportEventAction, Result, Status } from './index';

/** What a claim says it touches. Every field is optional. */
export interface WorkScope {
  /** Report areas or free words ("sync", "editor"), compared without case. */
  areas?: string[];
  /** File globs: `*` (within a folder), `**` (any depth), `?`. A folder (`src/server`, `src/server/`) covers what is under it. */
  paths?: string[];
  /** The migration slot the work takes (a timestamp or a named range), compared as text. */
  migration?: string;
  /** The git branch the work is on. */
  branch?: string;
}

export const SCOPE_LIMITS = { areas: 20, paths: 50, item: 200 } as const;

/** One way two scopes overlap: the kind, and the value from each side. */
export interface ScopeOverlap {
  kind: 'area' | 'path' | 'migration' | 'branch';
  a: string;
  b: string;
}

export interface ConflictSide {
  id: string;
  claimedBy: string | null;
  status: Status;
  scope: WorkScope;
}

export interface ClaimConflict {
  a: ConflictSide;
  b: ConflictSide;
  overlaps: ScopeOverlap[];
}

export interface ConflictReport {
  /** Claims in flight: claimed or in review. */
  active: number;
  /** Nothing is claimed or in review: the "queue free / main free" signal. */
  free: boolean;
  conflicts: ClaimConflict[];
}

/** An active claim and the scope it declared (null for none). */
export interface ActiveScope {
  report: Report;
  scope: WorkScope | null;
}

/** Statuses whose claim still holds its work area (a PR in review holds it until it merges). */
export const ACTIVE_STATUSES: readonly Status[] = ['claimed', 'in_review'];

/** History events after which an earlier scope no longer applies: a new holder starts clean. */
export const SCOPE_RESETS: readonly ReportEventAction[] = ['claimed', 'assigned', 'released', 'expired', 'reopened', 'closed'];

function list(v: unknown, max: number, name: string): Result<string[] | undefined> {
  if (v === undefined || v === null) return { ok: true, value: undefined };
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return { ok: false, error: `scope.${name} must be a list of strings.` };
  const out = (v as string[]).map((x) => x.trim()).filter(Boolean);
  if (out.length > max) return { ok: false, error: `scope.${name} takes at most ${max}.` };
  if (out.some((x) => x.length > SCOPE_LIMITS.item)) return { ok: false, error: `Each scope.${name} entry is at most ${SCOPE_LIMITS.item} characters.` };
  return { ok: true, value: out.length ? out : undefined };
}

function one(v: unknown, name: string): Result<string | undefined> {
  if (v === undefined || v === null) return { ok: true, value: undefined };
  if (typeof v !== 'string') return { ok: false, error: `scope.${name} must be a string.` };
  const s = v.trim();
  if (s.length > SCOPE_LIMITS.item) return { ok: false, error: `scope.${name} is at most ${SCOPE_LIMITS.item} characters.` };
  return { ok: true, value: s || undefined };
}

/** Checks an untrusted scope. Null (or one with nothing in it) means no scope. */
export function validateScope(raw: unknown): Result<WorkScope | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'scope must be an object: { areas?, paths?, migration?, branch? }.' };
  const r = raw as Record<string, unknown>;
  const areas = list(r.areas, SCOPE_LIMITS.areas, 'areas');
  if (!areas.ok) return areas;
  const paths = list(r.paths, SCOPE_LIMITS.paths, 'paths');
  if (!paths.ok) return paths;
  const migration = one(r.migration, 'migration');
  if (!migration.ok) return migration;
  const branch = one(r.branch, 'branch');
  if (!branch.ok) return branch;
  const scope: WorkScope = {
    ...(areas.value ? { areas: areas.value } : {}),
    ...(paths.value ? { paths: paths.value } : {}),
    ...(migration.value ? { migration: migration.value } : {}),
    ...(branch.value ? { branch: branch.value } : {}),
  };
  return { ok: true, value: Object.keys(scope).length ? scope : null };
}

/** Can two wildcard strings (`*`, `?`, no slashes) match one same string? */
function segmentsOverlap(a: string, b: string): boolean {
  const memo = new Map<number, boolean>();
  const go = (i: number, j: number): boolean => {
    const key = i * (b.length + 1) + j;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    let out: boolean;
    if (i === a.length && j === b.length) out = true;
    else if (a[i] === '*') out = go(i + 1, j) || (j < b.length && go(i, j + 1));
    else if (b[j] === '*') out = go(i, j + 1) || (i < a.length && go(i + 1, j));
    else if (i === a.length || j === b.length) out = false;
    else out = (a[i] === b[j] || a[i] === '?' || b[j] === '?') && go(i + 1, j + 1);
    memo.set(key, out);
    return out;
  };
  return go(0, 0);
}

/**
 * Folders of a glob, with "./" and a leading "/" dropped. A folder (ending in "/", or a last part
 * with no dot and no wildcard) covers what is under it.
 */
function segments(glob: string): string[] {
  const g = glob.trim().replace(/^\.\//, '');
  const parts = g.split('/').filter(Boolean);
  const last = parts.at(-1) ?? '';
  const folder = g.endsWith('/') || !/[.*?]/.test(last);
  return folder && last !== '**' ? [...parts, '**'] : parts;
}

/** Can two file globs match one same file? */
export function globsOverlap(a: string, b: string): boolean {
  const x = segments(a);
  const y = segments(b);
  const memo = new Map<number, boolean>();
  const go = (i: number, j: number): boolean => {
    const key = i * (y.length + 1) + j;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    let out: boolean;
    if (i === x.length && j === y.length) out = true;
    else if (x[i] === '**') out = go(i + 1, j) || (j < y.length && go(i, j + 1));
    else if (y[j] === '**') out = go(i, j + 1) || (i < x.length && go(i + 1, j));
    else if (i === x.length || j === y.length) out = false;
    else out = segmentsOverlap(x[i]!, y[j]!) && go(i + 1, j + 1);
    memo.set(key, out);
    return out;
  };
  return go(0, 0);
}

/** Every way two scopes overlap: shared areas, paths that can match one file, the same migration slot or branch. */
export function scopeOverlaps(a: WorkScope, b: WorkScope): ScopeOverlap[] {
  const out: ScopeOverlap[] = [];
  for (const x of a.areas ?? []) {
    const y = (b.areas ?? []).find((v) => v.toLowerCase() === x.toLowerCase());
    if (y !== undefined) out.push({ kind: 'area', a: x, b: y });
  }
  for (const x of a.paths ?? []) {
    const y = (b.paths ?? []).find((v) => globsOverlap(x, v));
    if (y !== undefined) out.push({ kind: 'path', a: x, b: y });
  }
  if (a.migration && a.migration === b.migration) out.push({ kind: 'migration', a: a.migration, b: b.migration });
  if (a.branch && a.branch === b.branch) out.push({ kind: 'branch', a: a.branch, b: b.branch });
  return out;
}

const side = ({ report, scope }: ActiveScope): ConflictSide => ({ id: report.id, claimedBy: report.claimedBy, status: report.status, scope: scope ?? {} });

/** Pairs of active claims whose scopes overlap, each pair once, in the order given. */
export function findConflicts(claims: readonly ActiveScope[]): ConflictReport {
  const conflicts: ClaimConflict[] = [];
  const scoped = claims.filter((c) => c.scope);
  for (let i = 0; i < scoped.length; i++) {
    for (let j = i + 1; j < scoped.length; j++) {
      const overlaps = scopeOverlaps(scoped[i]!.scope!, scoped[j]!.scope!);
      if (overlaps.length) conflicts.push({ a: side(scoped[i]!), b: side(scoped[j]!), overlaps });
    }
  }
  return { active: claims.length, free: claims.length === 0, conflicts };
}

/** The conflicts one report is part of. */
export const conflictsOf = (all: readonly ClaimConflict[], id: string) => all.filter((c) => c.a.id === id || c.b.id === id);

/** The other side of a conflict, seen from one report. */
export const otherSide = (c: ClaimConflict, id: string) => (c.a.id === id ? c.b : c.a);

/** "path src/server/** ~ src/server/handler.ts, migration 42": the overlaps in a few words. */
export function describeOverlaps(overlaps: readonly ScopeOverlap[]): string {
  return overlaps.map((o) => (o.a === o.b ? `${o.kind} ${o.a}` : `${o.kind} ${o.a} ~ ${o.b}`)).join(', ');
}

/** A one-paragraph warning for a claim's response, or undefined when it overlaps nothing. */
export function conflictWarning(all: readonly ClaimConflict[], id: string): string | undefined {
  const mine = conflictsOf(all, id);
  if (!mine.length) return undefined;
  const lines = mine.map((c) => {
    const o = otherSide(c, id);
    return `#${o.id.slice(0, 8)}${o.claimedBy ? ` (${o.claimedBy})` : ''}: ${describeOverlaps(c.overlaps)}`;
  });
  return `This claim overlaps ${mine.length === 1 ? 'another active claim' : `${mine.length} active claims`}: ${lines.join('; ')}. Nothing was blocked; coordinate before merging.`;
}

/** "Work area: areas sync; paths src/sync/**": a scope as the history note says it. */
export function describeScope(scope: WorkScope | null): string {
  if (!scope) return 'Work area cleared';
  const parts = [
    scope.areas ? `areas ${scope.areas.join(', ')}` : '',
    scope.paths ? `paths ${scope.paths.join(', ')}` : '',
    scope.migration ? `migration ${scope.migration}` : '',
    scope.branch ? `branch ${scope.branch}` : '',
  ].filter(Boolean);
  return `Work area: ${parts.join('; ')}`;
}

/** Does this history event set (or clear) a scope? */
const carriesScope = (e: ReportEvent) => Object.prototype.hasOwnProperty.call(e.detail ?? {}, 'scope');

/**
 * A report's current scope from its history (oldest first): the newest event that sets one, unless a
 * newer claim, assignment, release, expiry, reopen or close came after it.
 */
export function currentScope(events: readonly ReportEvent[]): WorkScope | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (carriesScope(e)) return (e.detail.scope as WorkScope | null) ?? null;
    if (SCOPE_RESETS.includes(e.action)) return null;
  }
  return null;
}
