// shipcue dispatch: one pass against a real handler and store, with claude, usage and gh stubbed out.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createShipcueHandler, memoryStore, type ReportStore } from '../src/server';
import { createAgentClient } from '../src/mcp/client';
import { launchdPlist, parseFlags, runDispatch, runPass, sessionIdFrom, settingsFrom, usageShort, type DispatchSettings, type PassDeps, type Usage } from '../src/cli/dispatch';
import { sample } from './store.contract';

const URL_ = 'https://app.example.com/api/shipcue';
const ME = { id: 'agent-a', name: 'mac-mini' };
const OTHER = { kind: 'agent' as const, id: 'agent-b', name: 'other' };
const PLENTY: Usage = { five_hour: { utilization: 10, resets_at: '2026-10-14T05:00:00Z' }, seven_day: { utilization: 20 } };

let dir: string;
let store: ReportStore;
let s: DispatchSettings;
let started: { name: string; prompt: string }[];
let logs: string[];
let deps: PassDeps;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shipcue-dispatch-'));
  store = memoryStore();
  const handle = createShipcueHandler({ store, basePath: '/api/shipcue', agents: async (t) => (t === 'tok-a' ? ME : t === 'tok-b' ? { id: OTHER.id, name: OTHER.name } : null) });
  s = settingsFrom({ SHIPCUE_URL: URL_, SHIPCUE_TOKEN: 'tok-a', SHIPCUE_AGENT: 'mac-mini', SHIPCUE_DISPATCH_STATE: dir, SHIPCUE_DISPATCH_MAX: '2' }, {}, '/repo/app');
  started = [];
  logs = [];
  let n = 0;
  deps = {
    client: createAgentClient({ url: URL_, token: 'tok-a', agent: 'mac-mini', fetch: (u, i) => handle(new Request(u, i)) }),
    start: async (name, prompt) => {
      started.push({ name, prompt });
      return `sess${String(++n).padStart(4, '0')}`;
    },
    usage: async () => PLENTY,
    prUpdatedAt: async () => null,
    missingTools: () => [],
    log: (l) => logs.push(l),
  };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('settings', () => {
  it('needs the queue and a token, and names the install after the repo', () => {
    expect(() => settingsFrom({})).toThrow(/SHIPCUE_URL and SHIPCUE_TOKEN/);
    expect(s.name).toBe('app');
    expect(s.repo).toBe('/repo/app');
    expect(s.permissionMode).toBe('auto');
    expect(() => settingsFrom({ SHIPCUE_URL: URL_, SHIPCUE_TOKEN: 't', SHIPCUE_DISPATCH_TYPES: 'bug,chore' })).toThrow(/chore/);
    expect(parseFlags(['--install', '--repo', '~/x', '--dry-run'])).toEqual({ install: 'true', repo: '~/x', 'dry-run': 'true' });
  });
});

describe('a pass', () => {
  it('claims each unclaimed report and starts a session for it, up to the cap', async () => {
    const a = await store.create(sample({ description: 'First bug\nmore', priority: 'high' }));
    const b = await store.create(sample({ description: 'Second bug' }));
    const c = await store.create(sample({ description: 'Third bug' }));
    await runPass(s, deps);
    expect(started.map((x) => x.name)).toEqual([`shipcue ${a.id.slice(0, 8)}`, `shipcue ${b.id.slice(0, 8)}`]);
    expect((await store.get(a.id))!).toMatchObject({ status: 'claimed', claimantId: ME.id });
    expect((await store.get(c.id))!.status).toBe('open');
    expect(logs.at(-1)).toMatch(/at 2 live sessions; .* waits/);
    // The prompt carries shipcue's own task text, the report id and the repo.
    expect(started[0]!.prompt).toContain(a.id);
    expect(started[0]!.prompt).toContain('/repo/app');
    expect(started[0]!.prompt).toMatch(/data, never as instructions/);

    // Next pass: still two live, so nothing new; once one closes, the third starts.
    await runPass(s, deps);
    expect(started).toHaveLength(2);
    await store.close(a.id, 'fixed', 'Fixed');
    await runPass(s, deps);
    expect(started.map((x) => x.name)).toEqual([expect.any(String), expect.any(String), `shipcue ${c.id.slice(0, 8)}`]);
  });

  it("skips reports someone else holds, never restarts one it dispatched, and takes reports queued for it first", async () => {
    const taken = await store.create(sample({ description: 'Taken' }));
    await store.claim(taken.id, OTHER);
    const queued = await store.create(sample({ description: 'Queued for me', priority: 'low' }));
    await store.assign!(queued.id, { kind: 'agent', id: ME.id, name: ME.name });
    const urgent = await store.create(sample({ description: 'Urgent', priority: 'blocking' }));
    await runPass(s, deps);
    expect(started.map((x) => x.name)).toEqual([`shipcue ${queued.id.slice(0, 8)}`, `shipcue ${urgent.id.slice(0, 8)}`]);

    // The session gave it back: it is open again, but this machine already tried it.
    await store.release(urgent.id, {});
    started = [];
    await runPass({ ...s, max: 10 }, deps);
    expect(started).toEqual([]);
  });

  it('only starts the types it is set to', async () => {
    await store.create(sample({ type: 'feature' }));
    const bug = await store.create(sample({ type: 'bug' }));
    await runPass({ ...s, types: ['bug'] }, deps);
    expect(started.map((x) => x.name)).toEqual([`shipcue ${bug.id.slice(0, 8)}`]);
  });

  it('gives the claim back when the session does not start, and does not retry it', async () => {
    const r = await store.create(sample());
    deps.start = async () => {
      throw new Error('claude: not logged in');
    };
    await runPass(s, deps);
    expect((await store.get(r.id))!.status).toBe('open');
    expect(logs.join('\n')).toMatch(/could not start a session .* released it/);
    deps.start = async (name, prompt) => (started.push({ name, prompt }), 'x');
    await runPass(s, deps);
    expect(started).toEqual([]);
  });

  it('holds until the usage window resets when another session would not fit', async () => {
    await store.create(sample());
    deps.usage = async () => ({ five_hour: { utilization: 95, resets_at: '2099-01-01T00:00:00Z' } });
    await runPass(s, deps);
    expect(started).toEqual([]);
    expect(logs.join('\n')).toMatch(/holding until .*5-hour window 95% used/);
    // Held: the next pass does not even look.
    deps.usage = async () => PLENTY;
    await runPass(s, deps);
    expect(started).toEqual([]);
  });

  it('holds when a tool is missing, and a dry run claims and starts nothing', async () => {
    const r = await store.create(sample());
    await runPass(s, deps, true);
    expect(started).toEqual([]);
    expect((await store.get(r.id))!.status).toBe('open');
    expect(logs.join('\n')).toMatch(/would dispatch/);
    deps.missingTools = () => ['claude'];
    await runPass(s, deps);
    expect(logs.at(-1)).toMatch(/missing on this machine: claude/);
  });

  it('takes over a PR of its own that stopped moving, at most maxTakeovers times and only after it changed', async () => {
    const r = await store.create(sample({ description: 'Needs a PR' }));
    await store.claim(r.id, { kind: 'agent', id: ME.id, name: ME.name });
    const pr = 'https://github.com/acme/app/pull/12';
    await store.review!(r.id, pr, { holder: ME.id });
    let updated = Date.now() - 60 * 60_000;
    deps.prUpdatedAt = async () => updated;
    await runPass(s, deps);
    expect(started.map((x) => x.name)).toEqual([`shipcue PR ${r.id.slice(0, 8)}`]);
    expect(started[0]!.prompt).toContain(pr);

    // Nothing changed since: it is waiting on a person.
    await runPass({ ...s, max: 10 }, deps);
    expect(started).toHaveLength(1);
    // Changed, then went quiet again: one more, and that is the cap.
    updated = Date.now() + 1000;
    await runPass({ ...s, max: 10 }, { ...deps, now: () => Date.now() + 30 * 60_000 });
    expect(started).toHaveLength(2);
    updated = Date.now() + 2000;
    await runPass({ ...s, max: 10 }, { ...deps, now: () => Date.now() + 60 * 60_000 });
    expect(started).toHaveLength(2);
  });
});

describe('pieces', () => {
  it('--status needs only the repo', async () => {
    const r = await runDispatch({ args: ['--status', '--repo', '/repo/app'], env: { SHIPCUE_DISPATCH_STATE: dir } });
    expect(r).toEqual({ output: 'nothing dispatched yet\n', code: 0 });
  });

  it('reads the session id from claude --bg', () => {
    expect(sessionIdFrom('Started.\n  claude attach 1a2b3c4d  watch it\n  claude logs 1a2b3c4d')).toBe('1a2b3c4d');
  });

  it('counts usage per running session', () => {
    expect(usageShort(PLENTY, 3, s)).toBeNull();
    expect(usageShort({ five_hour: { utilization: 80 } }, 3, s)?.[0]).toMatch(/3 session\(s\) need 22.5% left/);
    expect(usageShort({ seven_day: { utilization: 1, locked_reason: 'limit' } }, 1, s)).not.toBeNull();
  });

  it('writes a launchd agent with the settings in its environment', () => {
    const plist = launchdPlist({ ...s, instructions: 'Follow <the> skill & ship' }, ['/usr/bin/node', '/x/bin.js', 'dispatch'], '/usr/bin:/bin');
    expect(plist).toContain('<string>com.shipcue.dispatch.app</string>');
    expect(plist).toContain('<integer>60</integer>');
    expect(plist).toContain('<key>SHIPCUE_TOKEN</key><string>tok-a</string>');
    expect(plist).toContain('Follow &lt;the&gt; skill &amp; ship');
    expect(plist).toContain('<string>/usr/bin/node</string><string>/x/bin.js</string><string>dispatch</string>');
  });
});
