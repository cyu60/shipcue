// Stars and "yours", kept in this browser (shipcue report 013562b6): star any report to pin it
// to the top, in the report panel and on the CueLog. The panel also remembers the reports sent
// from this browser, so you can find yours again.
import { useEffect, useState } from 'react';
import type { MineItem, Status } from '../core';

const STARS = 'shipcue:stars';
const MINE = 'shipcue:mine';
const EVENT = 'shipcue:stars-changed';
const MAX_MINE = 50;

export interface MyReport {
  id: string;
  type: string;
  /** The first line of what was sent. */
  title: string;
  at: string;
  /** From the handler's GET /mine (the reporter portal), when it offers one: where it stands now. */
  status?: Status;
  resolution?: string | null;
  prUrl?: string | null;
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
export function rememberMine(r: MyReport): void {
  write(MINE, [r, ...loadMine().filter((x) => x.id !== r.id)].slice(0, MAX_MINE));
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
    byId.set(r.id, { id: r.id, type: r.type, title: r.title || had?.title || '', at: had?.at ?? r.createdAt, status: r.status, resolution: r.resolution, prUrl: r.prUrl });
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
