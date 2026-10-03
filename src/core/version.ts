// The installed shipcue version (shipcue report e4e1a85e). It comes from package.json at build time:
// tsup, vitest and the site's esbuild builds all define __SHIPCUE_VERSION__ from it, so the number
// lives in one place. `/capabilities` returns it, so a dashboard can tell which apps are behind.
declare const __SHIPCUE_VERSION__: string | undefined;

export const SHIPCUE_VERSION: string = typeof __SHIPCUE_VERSION__ === 'string' ? __SHIPCUE_VERSION__ : '0.0.0';

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;

/** A version as [major, minor, patch], or null when it is not one (pre-release tags are ignored). */
export function parseVersion(v: unknown): [number, number, number] | null {
  const m = typeof v === 'string' ? SEMVER.exec(v.trim()) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** -1, 0 or 1 as a is older than, the same as, or newer than b; null when either is not a version. */
export function compareVersions(a: unknown, b: unknown): -1 | 0 | 1 | null {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i]! !== y[i]!) return x[i]! < y[i]! ? -1 : 1;
  return 0;
}
