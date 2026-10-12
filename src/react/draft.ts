import type { ReportType } from '../core';

/**
 * A Bug or Feature request form not sent yet, as persistDraft keeps it in the browser, so leaving
 * the app (a phone that drops the tab, a reload) never wipes it (Habitect report e1204c25).
 */
export interface SavedDraft {
  type: ReportType;
  text: string;
  context: string | null;
  /** The screenshots and files, as attached. */
  files: File[];
  /** Alt text, one per file, '' when none. */
  alts: string[];
  /** The draft's idempotency key, so a send that landed before the tab went away is not filed twice. */
  key: string | null;
}

/** Where a draft is kept: the browser's IndexedDB by default, or your own (a test, a native shell). */
export interface DraftStore {
  load(): Promise<SavedDraft | null>;
  save(draft: SavedDraft): Promise<void>;
  clear(): Promise<void>;
}

/** True when the form holds something worth keeping. */
export function hasDraft(d: Pick<SavedDraft, 'text' | 'files'>): boolean {
  return d.text.trim().length > 0 || d.files.length > 0;
}

const DB_NAME = 'shipcue';
const DB_STORE = 'drafts';
const DRAFT_ID = 'report';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, act: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = act(db.transaction(DB_STORE, mode).objectStore(DB_STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

function isSavedDraft(v: unknown): v is SavedDraft {
  const d = v as SavedDraft | null;
  return !!d && typeof d.text === 'string' && typeof d.type === 'string' && Array.isArray(d.files) && Array.isArray(d.alts);
}

/**
 * The default store: one draft in IndexedDB, which keeps the screenshots as they are (localStorage
 * could not hold them). Where IndexedDB is missing or blocked (private mode), nothing is kept and
 * the form works as before.
 */
export function indexedDbDraftStore(): DraftStore {
  const available = () => typeof indexedDB !== 'undefined';
  return {
    async load() {
      if (!available()) return null;
      try {
        const v = await run('readonly', (s) => s.get(DRAFT_ID));
        return isSavedDraft(v) ? v : null;
      } catch {
        return null;
      }
    },
    async save(draft) {
      if (!available()) return;
      try {
        await run('readwrite', (s) => s.put(draft, DRAFT_ID));
      } catch {
        // Quota or blocked storage: the draft lasts until the page goes, as before.
      }
    },
    async clear() {
      if (!available()) return;
      try {
        await run('readwrite', (s) => s.delete(DRAFT_ID));
      } catch {
        // Nothing kept to clear.
      }
    },
  };
}
