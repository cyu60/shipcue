'use client';

// Recent errors in the page, attached to reports so a bug can be reproduced
// without asking. Listens once, keeps the last 20, never records request or
// response bodies.

export interface RecentError {
  at: string;
  kind: 'error' | 'rejection' | 'console';
  text: string;
}

const LIMIT = 20;
const recent: RecentError[] = [];
let installed = false;

function record(kind: RecentError['kind'], text: string): void {
  recent.push({ at: new Date().toISOString(), kind, text: text.slice(0, 500) });
  if (recent.length > LIMIT) recent.shift();
}

/** Start listening for errors. Safe to call more than once. */
export function captureErrors(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (e) => record('error', `${e.message}${e.filename ? ` at ${e.filename}:${e.lineno}` : ''}`));
  window.addEventListener('unhandledrejection', (e) => record('rejection', String(e.reason)));
  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    record('console', args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
    original(...args);
  };
}

/** The errors seen so far, oldest first. */
export function recentErrors(): RecentError[] {
  return [...recent];
}
