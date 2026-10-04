// Stars and "yours", kept in this browser (shipcue report 013562b6): star any report to pin it
// to the top, in the report panel and on the CueLog. The panel also remembers the reports sent
// from this browser, so you can find yours again, and open what you sent (shipcue report fec27a48).
import { useEffect, useState } from 'react';
import type { MineItem, Priority, Status } from '../core';

const STARS = 'shipcue:stars';
const MINE = 'shipcue:mine';
const EVENT = 'shipcue:stars-changed';
/** How many reports Yours keeps in this browser. */
export const MAX_MINE = 50;
/** The longest description or context kept per report; longer text is cut with an ellipsis. */
export const MAX_KEPT_TEXT = 4000;
/** The most the whole list may take in localStorage (characters of JSON); the oldest go first. */
export const MAX_MINE_BYTES = 200_000;

export interface MyReport {
  id: string;
  /** bug, feature, task, or the id of an extra tab. */
  type: string;
  /** The first line of what was sent. */
  title: string;
  at: string;
  /** From the handler's GET /mine (the reporter portal), when it offers one: where it stands now. */
  status?: Status;
  resolution?: string | null;
  prUrl?: string | null;
  // The rest of what was sent, kept since 0.28 (older entries just show less). Never the
  // screenshot or video data, only how many there were.
  /** The tab's label when it was sent ("Bug", or an extra tab's label). */
  typeLabel?: string;
  description?: string;
  priority?: Priority;
  area?: string;
  areaLabel?: string;
  pageUrl?: string | null;
  context?: string | null;
  screenshots?: number;
  files?: number;
  video?: boolean;
  /** Alt text per screenshot, in order, when any had some. */
  alts?: string[];
}

const cut = (v: unknown): string | undefined => (typeof v === 'string' ? (v.length > MAX_KEPT_TEXT ? `${v.slice(0, MAX_KEPT_TEXT)}…` : v) : undefined);
const str = (v: unknown, max = 2000): string | undefined => (typeof v === 'string' ? v.slice(0, max) : undefined);
const count = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined);

/** Only the known fields, text capped, counts as numbers: nothing else reaches storage. */
function keep(r: MyReport): MyReport {
  const out: Record<string, unknown> = {
    id: r.id,
    type: str(r.type, 100) ?? 'bug',
    title: str(r.title, 200) ?? '',
    at: str(r.at, 40) ?? new Date().toISOString(),
    status: str(r.status, 20),
    resolution: r.resolution === null ? null : str(r.resolution),
    prUrl: r.prUrl === null ? null : str(r.prUrl),
    typeLabel: str(r.typeLabel, 100),
    description: cut(r.description),
    priority: str(r.priority, 20),
    area: str(r.area, 100),
    areaLabel: str(r.areaLabel, 100),
    pageUrl: r.pageUrl === null ? null : typeof r.pageUrl === 'string' && !/^(data|blob):/i.test(r.pageUrl) ? r.pageUrl.slice(0, 2000) : undefined,
    context: r.context === null ? null : cut(r.context),
    screenshots: count(r.screenshots),
    files: count(r.files),
    video: typeof r.video === 'boolean' ? r.video : undefined,
    alts: Array.isArray(r.alts) && r.alts.some((a) => typeof a === 'string' && a.trim()) ? r.alts.slice(0, 20).map((a) => str(a, 500) ?? '') : undefined,
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out as unknown as MyReport;
}

function read<T>(key: string, fallback: T): T {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? 'null') as unknown;
    return (v ?? fallback) as T;
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage blocked: lasts until the page reloads.
  }
  window.dispatchEvent(new Event(EVENT));
}

export const loadStars = (): string[] => {
  const v = read<unknown>(STARS, []);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
};
export function toggleStar(id: string): void {
  const stars = loadStars();
  write(STARS, stars.includes(id) ? stars.filter((x) => x !== id) : [id, ...stars]);
}
export const loadMine = (): MyReport[] => {
  const v = read<unknown>(MINE, []);
  return Array.isArray(v) ? v.filter((x): x is MyReport => !!x && typeof (x as MyReport).id === 'string') : [];
};
/**
 * Keep a report sent from this browser at the top of Yours: newest first, at most MAX_MINE, and
 * the oldest dropped until the list fits MAX_MINE_BYTES (or the browser's own storage quota).
 */
export function rememberMine(r: MyReport): void {
  const list = [keep(r), ...loadMine().filter((x) => x.id !== r.id)].slice(0, MAX_MINE);
  while (list.length > 1 && JSON.stringify(list).length > MAX_MINE_BYTES) list.pop();
  for (;;) {
    try {
      localStorage.setItem(MINE, JSON.stringify(list));
      break;
    } catch {
      // Full or blocked: drop the oldest and try again; with one left, give up quietly.
      if (list.length <= 1) break;
      list.pop();
    }
  }
  window.dispatchEvent(new Event(EVENT));
}

/**
 * Yours on any device (shipcue report 3d0d7995): the reports the handler knows you filed, merged
 * with the ones sent from this browser. One per id (the server's status wins), newest first.
 * Pins stay in this browser; only the list itself comes from the server.
 */
export function mergeMine(local: readonly MyReport[], server: readonly MineItem[]): MyReport[] {
  const byId = new Map<string, MyReport>(local.map((m) => [m.id, m]));
  for (const r of server) {
    const had = byId.get(r.id);
    byId.set(r.id, { ...had, id: r.id, type: r.type, title: r.title || had?.title || '', at: had?.at ?? r.createdAt, status: r.status, resolution: r.resolution, prUrl: r.prUrl });
  }
  return [...byId.values()].sort((a, b) => b.at.localeCompare(a.at));
}

/** Starred ids first, in their order, then the rest as they were. */
export function starredFirst<T extends { id: string }>(items: readonly T[], stars: readonly string[]): T[] {
  const set = new Set(stars);
  return [...items.filter((i) => set.has(i.id)), ...items.filter((i) => !set.has(i.id))];
}

/** Stars and your reports, kept in step across the panel, the board and other tabs. */
export function useStars() {
  const [stars, setStars] = useState<string[]>([]);
  const [mine, setMine] = useState<MyReport[]>([]);
  useEffect(() => {
    const sync = () => {
      setStars(loadStars());
      setMine(loadMine());
    };
    sync();
    const onStorage = (e: StorageEvent) => (e.key === STARS || e.key === MINE) && sync();
    window.addEventListener(EVENT, sync);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  return { stars, mine, isStarred: (id: string) => stars.includes(id), toggle: toggleStar, isMine: (id: string) => mine.some((m) => m.id === id) };
}

/** A small star toggle. */
export const STAR_ON = '★';
export const STAR_OFF = '☆';
