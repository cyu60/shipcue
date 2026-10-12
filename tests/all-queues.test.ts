// One view of every queue (shipcue report e4e1a85e): the version in /capabilities and the CueLog's
// "Nobody has looked" filter. Cloud's All projects overview is tested with Cloud.
import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeEach } from 'vitest';
import { SHIPCUE_VERSION, compareVersions, parseVersion, type Report } from '../src/core';
import { createShipcueHandler, memoryStore } from '../src/server';
import { filterReports, nobodyLooked } from '../src/react/CueLog';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

describe('the installed version', () => {
  it('is package.json\'s version, set at build time', () => {
    expect(SHIPCUE_VERSION).toBe(pkg.version);
  });

  it('compares versions, and says null for anything that is not one', () => {
    expect(compareVersions('0.17.0', '0.25.0')).toBe(-1);
    expect(compareVersions('0.25.0', '0.25.0')).toBe(0);
    expect(compareVersions('1.0.0', '0.99.9')).toBe(1);
    expect(compareVersions('0.9.0', '0.10.0')).toBe(-1);
    expect(compareVersions('v0.24.2', '0.24.2')).toBe(0);
    expect(compareVersions('nope', '0.1.0')).toBeNull();
    expect(compareVersions(undefined, '0.1.0')).toBeNull();
    expect(parseVersion('0.24.2-beta.1')).toEqual([0, 24, 2]);
  });

  it('comes back from /capabilities', async () => {
    const handle = createShipcueHandler({ store: memoryStore(), basePath: '/api/shipcue' });
    const caps = await (await handle(new Request('https://app.example.com/api/shipcue/capabilities'))).json();
    expect(caps.version).toBe(pkg.version);
  });
});

describe('the CueLog: Nobody has looked', () => {
  const base: Report = {
    id: 'r1',
    type: 'bug',
    priority: 'medium',
    area: 'other',
    description: 'x',
    pageUrl: '',
    userAgent: '',
    diagnostics: {},
    screenshots: [],
    reporter: null,
    status: 'open',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    claimedBy: null,
    claimedAt: null,
    resolution: null,
    video: null,
    context: null,
  };
  it('keeps open reports nobody holds and nothing has happened to since filing (a video added while filing aside)', () => {
    const untouched = base;
    const withVideo = { ...base, id: 'r2', updatedAt: '2026-10-01T00:00:40.000Z' };
    const noted = { ...base, id: 'r3', updatedAt: '2026-10-01T05:00:00.000Z' };
    const queued = { ...base, id: 'r4', claimantKind: 'agent' as const, claimantId: 'a1', claimedBy: 'bot' };
    const claimed = { ...base, id: 'r5', status: 'claimed' as const, claimantKind: 'agent' as const, claimantId: 'a1', claimedBy: 'bot' };
    const fixed = { ...base, id: 'r6', status: 'fixed' as const };
    expect([untouched, withVideo, noted, queued, claimed, fixed].map(nobodyLooked)).toEqual([true, true, false, false, false, false]);
    expect(filterReports([untouched, withVideo, noted, queued, claimed, fixed], { tab: 'open', claimant: 'unlooked' }, null).map((r) => r.id)).toEqual(['r1', 'r2']);
  });
});
