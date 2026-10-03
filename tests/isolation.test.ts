// Isolation regression suite for Cloud (shipcue report 407a5d6d). One table holds every Cloud
// project's reports plus the app's own (project: null). On 2026-10-03 the site's own queue read every
// Cloud project's reports (fixed in 0.16.1); this file runs every read and write path with two
// projects and an own-rows store on one database, and checks nothing crosses over, in every direction.
import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createShipcueHandler, postgresStore, type ReportStore } from '../src/server';
import type { Report, ReportEvent } from '../src/core';
// @ts-expect-error -- plain JS module for the site's function
import { createCloudHandler } from '../website/_src/cloud.mjs';

const schema = readFileSync(new URL('../sql/schema.sql', import.meta.url), 'utf8');
const cloudSql = readFileSync(new URL('../sql/cloud.sql', import.meta.url), 'utf8');
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const PNG = `data:image/png;base64,${Buffer.from('not really a png').toString('base64')}`;
const agentBot = { kind: 'agent' as const, id: 'bot', name: 'bot' };
const person = { kind: 'person' as const, id: 'p1', name: 'Pat' };

type Name = 'A' | 'B' | 'own';
const NAMES: Name[] = ['A', 'B', 'own'];
/** Every ordered pair of different queues: [the one asking, the one whose rows it must not touch]. */
const PAIRS = NAMES.flatMap((x) => NAMES.filter((y) => y !== x).map((y) => [x, y] as const));

async function freshDb() {
  const db = new PGlite();
  await db.exec(schema);
  await db.exec(cloudSql);
  return { db, q: { query: (text: string, params?: unknown[]) => db.query(text, params) } };
}

/** One report in each state the methods act on: open, queued for an agent, claimed (lease run out), in review, fixed. */
async function seed(store: ReportStore, label: string) {
  const make = (what: string) =>
    store.create({
      type: 'bug',
      priority: 'high',
      area: 'other',
      description: `${label}: ${what}`,
      pageUrl: '',
      userAgent: '',
      diagnostics: {},
      screenshots: [PNG],
      reporter: null,
      clientKey: 'same-client',
    });
  const open = await make('open');
  const queued = await make('queued');
  await store.assign!(queued.id, agentBot, person);
  const claimed = await make('claimed');
  await store.claim(claimed.id, agentBot, { leaseSeconds: -60 });
  const review = await make('review');
  await store.review!(review.id, 'https://github.com/x/y/pull/1');
  const fixed = await make('fixed');
  await store.close(fixed.id, 'fixed', 'done');
  return { open, queued, claimed, review, fixed, ids: [open.id, queued.id, claimed.id, review.id, fixed.id] };
}

/** Everything a queue holds: its rows and each row's history. */
async function snapshot(store: ReportStore): Promise<{ rows: Report[]; events: Record<string, ReportEvent[]> }> {
  const rows = await store.list();
  const events: Record<string, ReportEvent[]> = {};
  for (const r of rows) events[r.id] = await store.events!(r.id);
  return { rows, events };
}

async function world() {
  const { db, q } = await freshDb();
  const stores: Record<Name, ReportStore> = {
    A: postgresStore(q, 'shipcue_reports', { project: A }),
    B: postgresStore(q, 'shipcue_reports', { project: B }),
    own: postgresStore(q, 'shipcue_reports', { project: null }),
  };
  const seeded = {
    A: await seed(stores.A, 'A'),
    B: await seed(stores.B, 'B'),
    own: await seed(stores.own, 'own'),
  };
  return { db, q, stores, seeded };
}

describe('isolation: store methods', () => {
  let w: Awaited<ReturnType<typeof world>>;
  beforeEach(async () => {
    w = await world();
  });

  it('list, get, events and version only ever show the queue\'s own rows', async () => {
    for (const n of NAMES) {
      const mine = new Set(w.seeded[n].ids);
      const rows = await w.stores[n].list();
      expect(rows.map((r) => r.id).sort()).toEqual([...mine].sort());
      expect(rows.every((r) => r.description.startsWith(`${n}:`))).toBe(true);
      for (const status of ['open', 'claimed', 'in_review', 'fixed', 'wontfix'] as const) {
        expect((await w.stores[n].list({ status })).every((r) => mine.has(r.id))).toBe(true);
      }
      // Every queue queued a report for "bot"; each sees only its own.
      expect((await w.stores[n].list({ claimant: 'bot' })).map((r) => r.id).sort()).toEqual([w.seeded[n].queued.id, w.seeded[n].claimed.id].sort());
    }
    for (const [x, y] of PAIRS) {
      for (const id of w.seeded[y].ids) {
        expect(await w.stores[x].get(id)).toBeNull();
        expect(await w.stores[x].events!(id)).toEqual([]);
      }
    }
  });

  it('no write reaches another queue\'s reports, and nothing about them changes', async () => {
    const before = { A: await snapshot(w.stores.A), B: await snapshot(w.stores.B), own: await snapshot(w.stores.own) };
    for (const [x, y] of PAIRS) {
      const s = w.stores[x];
      for (const id of w.seeded[y].ids) {
        expect(await s.claim(id, 'intruder')).toBeNull();
        expect(await s.claim(id, agentBot)).toBeNull();
        expect(await s.release(id)).toBeNull();
        expect(await s.release(id, { holder: 'bot' })).toBeNull();
        expect(await s.close(id, 'wontfix', 'not yours')).toBeNull();
        expect(await s.attachVideo(id, 'https://example.com/v.webm')).toBeNull();
        expect(await s.assign!(id, person, person)).toBeNull();
        expect(await s.assign!(id, null, person)).toBeNull();
        expect(await s.heartbeat!(id, 'bot', 600)).toBeNull();
        expect(await s.review!(id, 'https://github.com/x/y/pull/9')).toBeNull();
        expect(await s.reopen!(id, person)).toBeNull();
        expect(await s.setPriority!(id, 'blocking', person)).toBeNull();
        expect(await s.note!(id, 'sneaky note', person)).toBeNull();
        expect(await s.edit!(id, { description: 'rewritten' }, person)).toBeNull();
        expect(await s.edit!(id, {}, person)).toBeNull();
      }
    }
    expect({ A: await snapshot(w.stores.A), B: await snapshot(w.stores.B), own: await snapshot(w.stores.own) }).toEqual(before);
  });

  it('claimNext only takes the queue\'s own reports, assigned or pulled', async () => {
    for (const n of NAMES) {
      const mine = new Set(w.seeded[n].ids);
      // Assigned-only: just the one queued for bot in this queue.
      const queued = await w.stores[n].claimNext('bot', { pull: false });
      expect(queued?.id).toBe(w.seeded[n].queued.id);
      expect(await w.stores[n].claimNext('bot', { pull: false })).toBeNull();
      // Pull mode drains this queue's open reports and then stops, with others' still open.
      const taken: string[] = [];
      for (let r = await w.stores[n].claimNext('puller'); r; r = await w.stores[n].claimNext('puller')) taken.push(r.id);
      expect(taken.every((id) => mine.has(id))).toBe(true);
      expect(taken).toEqual([w.seeded[n].open.id]);
    }
    expect((await w.stores.A.claimNext('anyone', { types: ['bug', 'feature', 'task'] }))).toBeNull();
  });

  it('expire only frees the queue\'s own run-out leases, and the history stays put', async () => {
    // Each expire returns exactly its own report, and the others' stay claimed until their own runs.
    const freed = await w.stores.A.expire!();
    expect(freed.map((r) => r.id)).toEqual([w.seeded.A.claimed.id]);
    expect((await w.stores.B.get(w.seeded.B.claimed.id))?.status).toBe('claimed');
    expect((await w.stores.own.get(w.seeded.own.claimed.id))?.status).toBe('claimed');
    expect((await w.stores.own.expire!()).map((r) => r.id)).toEqual([w.seeded.own.claimed.id]);
    expect((await w.stores.B.get(w.seeded.B.claimed.id))?.status).toBe('claimed');
    expect((await w.stores.B.expire!()).map((r) => r.id)).toEqual([w.seeded.B.claimed.id]);
    // Each 'expired' event sits under its own project.
    const { rows } = await w.db.query<{ project_id: string | null; report_id: string }>(`SELECT project_id, report_id FROM shipcue_report_events WHERE action = 'expired'`);
    const where = Object.fromEntries(rows.map((r) => [r.report_id, r.project_id]));
    expect(where).toEqual({ [w.seeded.A.claimed.id]: A, [w.seeded.B.claimed.id]: B, [w.seeded.own.claimed.id]: null });
  });

  it('version moves only with the queue\'s own changes', async () => {
    for (const [x, y] of PAIRS) {
      const v = await w.stores[x].version!();
      await w.stores[y].setPriority!(w.seeded[y].open.id, 'low', person);
      await w.stores[y].note!(w.seeded[y].open.id, 'moves y', person);
      await w.stores[y].create({ type: 'task', priority: 'low', area: 'other', description: `${y}: more`, pageUrl: '', userAgent: '', diagnostics: {}, screenshots: [], reporter: null });
      expect(await w.stores[x].version!()).toBe(v);
      await w.stores[x].setPriority!(w.seeded[x].open.id, 'blocking', person);
      expect(await w.stores[x].version!()).not.toBe(v);
    }
  });

  it('countFromClient counts only the queue\'s own signed-out reports', async () => {
    for (const n of NAMES) expect(await w.stores[n].countFromClient!('same-client')).toBe(5);
  });

  it('every history row a store writes carries its own project', async () => {
    for (const n of NAMES) {
      await w.stores[n].note!(w.seeded[n].open.id, 'hello', person);
      await w.stores[n].edit!(w.seeded[n].open.id, { description: `${n}: edited` }, person);
    }
    const { rows } = await w.db.query<{ project_id: string | null; report_project: string | null }>(
      `SELECT e.project_id, r.project_id AS report_project FROM shipcue_report_events e JOIN shipcue_reports r ON r.id = e.report_id`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.project_id !== r.report_project)).toEqual([]);
  });
});

describe('isolation: the handler (board, screenshots, team API, agent API)', () => {
  const ORIGIN = 'https://h.example.com';
  let w: Awaited<ReturnType<typeof world>>;
  let handlers: Record<Name, (req: Request) => Promise<Response>>;
  const base = (n: Name) => `/api/${n}`;
  const TOKENS: Record<Name, string> = { A: 'token-a', B: 'token-b', own: 'token-own' };

  beforeEach(async () => {
    w = await world();
    const make = (n: Name) =>
      createShipcueHandler({
        store: w.stores[n],
        basePath: base(n),
        board: true,
        boardScreenshots: true,
        agentToken: TOKENS[n],
        acceptVideoUrl: async () => true,
        team: { getMember: async () => ({ id: 'p1', name: 'Pat', role: 'owner' }), claimants: async () => [person, agentBot] },
      });
    handlers = { A: make('A'), B: make('B'), own: make('own') };
  });

  const get = (n: Name, path: string, headers: Record<string, string> = {}) => handlers[n](new Request(ORIGIN + base(n) + path, { headers }));
  const post = (n: Name, path: string, body: unknown, headers: Record<string, string> = {}) =>
    handlers[n](new Request(ORIGIN + base(n) + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }));

  it('the public board and its screenshots show only the queue\'s own reports', async () => {
    for (const n of NAMES) {
      const board = await (await get(n, '/board')).json();
      const all = [...board.queue, ...board.changelog];
      expect(all.length).toBeGreaterThan(0);
      expect(all.every((i: { description?: string; title?: string }) => JSON.stringify(i).includes(`${n}:`))).toBe(true);
      for (const y of NAMES.filter((y) => y !== n)) expect(JSON.stringify(board)).not.toContain(`${y}:`);
      expect((await get(n, `/board/screenshot/${w.seeded[n].open.id}/0`)).status).toBe(200);
    }
    for (const [x, y] of PAIRS) {
      for (const id of w.seeded[y].ids) expect((await get(x, `/board/screenshot/${id}/0`)).status).toBe(404);
    }
  });

  it('the board version and the team version ignore other queues', async () => {
    for (const [x, y] of PAIRS) {
      const board = (await (await get(x, '/board/version')).json()).version;
      const team = (await (await get(x, '/team/version')).json()).version;
      await w.stores[y].setPriority!(w.seeded[y].open.id, 'low', person);
      expect((await (await get(x, '/board/version')).json()).version).toBe(board);
      expect((await (await get(x, '/team/version')).json()).version).toBe(team);
    }
  });

  // The list routes free each queue's own run-out lease first; do that up front so the snapshots compare.
  const expireAll = () => Promise.all(NAMES.map((n) => w.stores[n].expire!()));

  it('as a member of one queue, another queue\'s ids are 404 (or refused) on every team route', async () => {
    await expireAll();
    const before = { A: await snapshot(w.stores.A), B: await snapshot(w.stores.B), own: await snapshot(w.stores.own) };
    for (const [x, y] of PAIRS) {
      const list = await (await get(x, '/team/reports')).json();
      expect(list.reports.map((r: Report) => r.id).sort()).toEqual([...w.seeded[x].ids].sort());
      for (const id of w.seeded[y].ids) {
        expect((await get(x, `/team/reports/${id}`)).status).toBe(404);
        expect((await get(x, `/team/screenshot/${id}/0`)).status).toBe(404);
        const writes: [string, unknown][] = [
          ['claim', {}],
          ['assign', { to: { kind: 'person', id: 'p1' } }],
          ['assign', { to: null }],
          ['release', {}],
          ['close', { status: 'wontfix', resolution: 'no' }],
          ['reopen', {}],
          ['review', { prUrl: 'https://github.com/x/y/pull/2' }],
          ['note', { text: 'sneaky' }],
          ['edit', { description: 'rewritten by someone else entirely' }],
          ['priority', { priority: 'blocking' }],
        ];
        for (const [action, body] of writes) {
          const res = await post(x, `/team/reports/${id}/${action}`, body);
          expect([404, 409], `${x} team ${action} on ${y}'s report`).toContain(res.status);
          expect(JSON.stringify(await res.json())).not.toContain(`${y}:`);
        }
      }
    }
    expect({ A: await snapshot(w.stores.A), B: await snapshot(w.stores.B), own: await snapshot(w.stores.own) }).toEqual(before);
  });

  it("an agent's token works only on its own queue, and never reaches another's ids", async () => {
    await expireAll();
    const before = { A: await snapshot(w.stores.A), B: await snapshot(w.stores.B), own: await snapshot(w.stores.own) };
    for (const [x, y] of PAIRS) {
      // The other queue's token is not a token here.
      expect((await get(x, '/reports', { authorization: `Bearer ${TOKENS[y]}` })).status).toBe(401);
      const auth = { authorization: `Bearer ${TOKENS[x]}` };
      const list = await (await get(x, '/reports', auth)).json();
      expect(list.reports.every((r: Report) => w.seeded[x].ids.includes(r.id) || r.description.startsWith(`${x}:`))).toBe(true);
      for (const id of w.seeded[y].ids) {
        expect((await get(x, `/reports/${id}`, auth)).status).toBe(404);
        expect((await get(x, `/reports/${id}/events`, auth)).status).toBe(404);
        const writes: [string, unknown][] = [
          ['claim', { agent: 'bot' }],
          ['release', { agent: 'bot' }],
          ['heartbeat', { agent: 'bot' }],
          ['review', { agent: 'bot', prUrl: 'https://github.com/x/y/pull/3' }],
          ['close', { agent: 'bot', status: 'fixed', resolution: 'no' }],
          ['note', { agent: 'bot', text: 'sneaky' }],
        ];
        for (const [action, body] of writes) {
          const res = await post(x, `/reports/${id}/${action}`, body, auth);
          expect([404, 409], `${x} agent ${action} on ${y}'s report`).toContain(res.status);
          expect(JSON.stringify(await res.json())).not.toContain(`${y}:`);
        }
        // The button's video route too.
        expect((await post(x, `/reports/${id}/video`, { url: 'https://example.com/v.webm' })).status).toBe(404);
      }
    }
    expect({ A: await snapshot(w.stores.A), B: await snapshot(w.stores.B), own: await snapshot(w.stores.own) }).toEqual(before);
    // next/claim drains only its own queue.
    for (const n of NAMES) {
      const auth = { authorization: `Bearer ${TOKENS[n]}` };
      for (let res = await post(n, '/reports/next/claim', { agent: 'bot' }, auth); res.status === 200; res = await post(n, '/reports/next/claim', { agent: 'bot' }, auth)) {
        const { report } = await res.json();
        expect(report.description.startsWith(`${n}:`)).toBe(true);
      }
    }
  });
});

describe('isolation: shipcue Cloud (website/_src/cloud.mjs) and the site\'s own queue', () => {
  const BASE = 'https://shipcue.example.com/api/cloud';
  let db: PGlite;
  let q: { query: (t: string, p?: unknown[]) => Promise<{ rows: unknown[] }> };
  let handle: (req: Request) => Promise<Response>;
  const jar = new Map<string, string>();

  function fakeAuth() {
    const users = new Map<string, string>();
    const tokens = (email: string) => ({ accessToken: `at:${email}`, refreshToken: `rt:${email}`, user: { id: users.get(email)!, email } });
    return {
      async signUp(email: string) {
        users.set(email, crypto.randomUUID());
        return { tokens: tokens(email), needsVerification: false };
      },
      async current(token: string) {
        const email = token.startsWith('at:') ? token.slice(3) : '';
        return users.has(email) ? { id: users.get(email)!, email } : null;
      },
      async refresh() {
        return null;
      },
    };
  }

  async function call(method: string, path: string, opts: { as?: string; body?: unknown; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...opts.headers };
    if (opts.as) headers.cookie = jar.get(opts.as)!;
    const res = await handle(new Request(BASE + path, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined }));
    return { res, data: await res.clone().json().catch(() => null) };
  }

  /** Two projects with an owner, an agent, a public board and filed reports each; plus the site's own rows. */
  async function setup() {
    ({ db, q } = await freshDb());
    handle = createCloudHandler({ db: q, auth: fakeAuth(), beta: ['ada@example.com', 'bob@example.com'], secureCookies: false });
    const projects: Record<'A' | 'B', { id: string; key: string; token: string; agentId: string; owner: string; reports: string[] }> = {} as never;
    for (const [n, owner] of [['A', 'ada@example.com'], ['B', 'bob@example.com']] as const) {
      const { res } = await call('POST', '/auth/sign-up', { body: { email: owner, password: 'long-enough-pw' } });
      jar.set(owner, res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '));
      const { data } = await call('POST', '/projects', { as: owner, body: { name: `Project ${n}` } });
      const { id, publicKey } = data.project;
      await call('POST', `/projects/${id}/settings`, { as: owner, body: { publicBoard: true } });
      const { data: agent } = await call('POST', `/projects/${id}/agents`, { as: owner, body: { name: `agent-${n.toLowerCase()}` } });
      const reports: string[] = [];
      for (const what of ['open', 'to close']) {
        const form = new FormData();
        for (const [k, v] of Object.entries({ type: 'bug', priority: 'high', area: 'other', description: `${n}: report that is ${what}` })) form.set(k, v);
        form.append('screenshot', new File([new Uint8Array(8)], 's.png', { type: 'image/png' }));
        const filed = await handle(new Request(`${BASE}/p/${publicKey}/reports`, { method: 'POST', body: form }));
        expect(filed.status).toBe(201);
        reports.push((await filed.json()).id);
      }
      const { data: me } = await call('GET', `/p/${publicKey}/team/me`, { as: owner });
      const agentId = me.claimants.find((c: { kind: string }) => c.kind === 'agent').id;
      projects[n] = { id, key: publicKey, token: agent.token, agentId, owner, reports };
      await call('POST', `/p/${publicKey}/team/reports/${reports[1]}/close`, { as: owner, body: { status: 'fixed', resolution: 'done' } });
    }
    // The site's own queue: the same store website/_src/api.mjs builds.
    const own = postgresStore(q, 'shipcue_reports', { project: null });
    const mine = await own.create({ type: 'bug', priority: 'blocking', area: 'other', description: 'own: site report', pageUrl: '', userAgent: '', diagnostics: {}, screenshots: [PNG], reporter: null });
    const site = createShipcueHandler({ store: own, basePath: '/api/shipcue', board: true, boardScreenshots: true, agentToken: 'site-token', team: { getMember: async () => ({ id: 'p1', name: 'Pat', role: 'owner' }) } });
    return { projects, own, mine, site };
  }

  it("a member of A gets 404 for B's ids on every per-project route, and B's queue stays shut to A", async () => {
    const { projects } = await setup();
    const snap = async () => (await db.query(`SELECT id, status, priority, description, claimant_id, resolution, updated_at FROM shipcue_reports ORDER BY id`)).rows;
    const eventsBefore = (await db.query(`SELECT count(*)::int AS n FROM shipcue_report_events`)).rows;
    const before = await snap();
    for (const [x, y] of [['A', 'B'], ['B', 'A']] as const) {
      const me = projects[x];
      const them = projects[y];
      // Their queue: not a member, not their token.
      expect((await call('GET', `/p/${them.key}/team/reports`, { as: me.owner })).res.status).toBe(401);
      expect((await call('GET', `/p/${them.key}/team/reports/${them.reports[0]}`, { as: me.owner })).res.status).toBe(401);
      expect((await call('POST', `/p/${them.key}/team/reports/${them.reports[0]}/close`, { as: me.owner, body: { status: 'wontfix' } })).res.status).toBe(401);
      expect((await handle(new Request(`${BASE}/p/${them.key}/reports`, { headers: { authorization: `Bearer ${me.token}` } }))).status).toBe(401);
      expect((await call('GET', `/projects/${them.id}`, { as: me.owner })).res.status).toBe(404);
      // Their ids through my own queue.
      const { data: list } = await call('GET', `/p/${me.key}/team/reports`, { as: me.owner });
      expect(list.reports.map((r: Report) => r.id).sort()).toEqual([...me.reports].sort());
      expect((await call('GET', `/p/${me.key}/team/version`, { as: me.owner })).res.status).toBe(200);
      for (const id of them.reports) {
        expect((await call('GET', `/p/${me.key}/team/reports/${id}`, { as: me.owner })).res.status).toBe(404);
        expect((await call('GET', `/p/${me.key}/team/screenshot/${id}/0`, { as: me.owner })).res.status).toBe(404);
        for (const [action, body] of [
          ['claim', {}],
          ['assign', { to: null }],
          ['release', {}],
          ['close', { status: 'wontfix', resolution: 'no' }],
          ['reopen', {}],
          ['review', { prUrl: 'https://github.com/x/y/pull/2' }],
          ['note', { text: 'sneaky' }],
          ['edit', { description: 'rewritten by someone else entirely' }],
          ['priority', { priority: 'blocking' }],
        ] as const) {
          const { res, data } = await call('POST', `/p/${me.key}/team/reports/${id}/${action}`, { as: me.owner, body });
          expect([404, 409], `${x} team ${action} on ${y}'s report`).toContain(res.status);
          expect(JSON.stringify(data)).not.toContain(`${y}:`);
        }
        // My agent token on their ids.
        const auth = { authorization: `Bearer ${me.token}`, 'content-type': 'application/json' };
        expect((await handle(new Request(`${BASE}/p/${me.key}/reports/${id}`, { headers: auth }))).status).toBe(404);
        expect((await handle(new Request(`${BASE}/p/${me.key}/reports/${id}/events`, { headers: auth }))).status).toBe(404);
        for (const action of ['claim', 'release', 'heartbeat', 'review', 'close', 'note']) {
          const res = await handle(
            new Request(`${BASE}/p/${me.key}/reports/${id}/${action}`, {
              method: 'POST',
              headers: auth,
              body: JSON.stringify({ status: 'fixed', prUrl: 'https://github.com/x/y/pull/3', text: 'sneaky' }),
            }),
          );
          expect([404, 409], `${x} agent ${action} on ${y}'s report`).toContain(res.status);
        }
      }
      // Their agent cannot be handed my reports.
      const { res: assignRes } = await call('POST', `/p/${me.key}/team/reports/${me.reports[0]}/assign`, { as: me.owner, body: { to: { kind: 'agent', id: them.agentId } } });
      expect(assignRes.status).toBe(400);
    }
    expect(await snap()).toEqual(before);
    expect((await db.query(`SELECT count(*)::int AS n FROM shipcue_report_events`)).rows).toEqual(eventsBefore);
  });

  it('each public board, board version and next/claim keeps to its own project', async () => {
    const { projects } = await setup();
    for (const [x, y] of [['A', 'B'], ['B', 'A']] as const) {
      const board = await (await handle(new Request(`${BASE}/p/${projects[x].key}/board`))).json();
      expect(board.queue.length + board.changelog.length).toBe(2);
      expect(JSON.stringify(board)).not.toContain(`${y}:`);
      const version = async () => (await (await handle(new Request(`${BASE}/p/${projects[x].key}/board/version`))).json()).version;
      const v = await version();
      await call('POST', `/p/${projects[y].key}/team/reports/${projects[y].reports[0]}/priority`, { as: projects[y].owner, body: { priority: 'low' } });
      expect(await version()).toBe(v);
      for (const id of projects[y].reports) {
        expect((await handle(new Request(`${BASE}/p/${projects[x].key}/board/screenshot/${id}/0`))).status).toBe(404);
      }
    }
    for (const n of ['A', 'B'] as const) {
      const auth = { authorization: `Bearer ${projects[n].token}` };
      const res = await handle(new Request(`${BASE}/p/${projects[n].key}/reports/next/claim`, { method: 'POST', headers: auth }));
      expect(res.status).toBe(200);
      expect((await res.json()).report.id).toBe(projects[n].reports[0]);
      expect((await handle(new Request(`${BASE}/p/${projects[n].key}/reports/next/claim`, { method: 'POST', headers: auth }))).status).toBe(204);
    }
  });

  it("the site's own queue never sees Cloud rows, and Cloud never sees the site's", async () => {
    const { projects, own, mine, site } = await setup();
    const cloudIds = [...projects.A.reports, ...projects.B.reports];
    expect((await own.list()).map((r) => r.id)).toEqual([mine.id]);
    for (const id of cloudIds) expect(await own.get(id)).toBeNull();
    const sget = (path: string, headers: Record<string, string> = {}) => site(new Request(`https://shipcue.example.com/api/shipcue${path}`, { headers }));
    const board = await (await sget('/board')).json();
    expect(JSON.stringify(board)).not.toMatch(/"[AB]: /);
    expect(board.queue.map((i: { id: string }) => i.id)).toEqual([mine.id]);
    const team = await (await sget('/team/reports')).json();
    expect(team.reports.map((r: Report) => r.id)).toEqual([mine.id]);
    const agent = await (await sget('/reports', { authorization: 'Bearer site-token' })).json();
    expect(agent.reports.map((r: Report) => r.id)).toEqual([mine.id]);
    for (const id of cloudIds) {
      expect((await sget(`/team/reports/${id}`)).status).toBe(404);
      expect((await sget(`/reports/${id}`, { authorization: 'Bearer site-token' })).status).toBe(404);
      expect((await sget(`/board/screenshot/${id}/0`)).status).toBe(404);
    }
    // A Cloud project's change does not move the site's version, and the site's own change does not move Cloud's.
    const siteV = (await (await sget('/board/version')).json()).version;
    await call('POST', `/p/${projects.A.key}/team/reports/${projects.A.reports[0]}/note`, { as: projects.A.owner, body: { text: 'cloud note' } });
    expect((await (await sget('/board/version')).json()).version).toBe(siteV);
    const cloudV = (await (await handle(new Request(`${BASE}/p/${projects.A.key}/board/version`))).json()).version;
    await own.setPriority!(mine.id, 'low', null);
    expect((await (await handle(new Request(`${BASE}/p/${projects.A.key}/board/version`))).json()).version).toBe(cloudV);
    // Cloud never shows the site's own report either.
    for (const n of ['A', 'B'] as const) {
      expect((await call('GET', `/p/${projects[n].key}/team/reports/${mine.id}`, { as: projects[n].owner })).res.status).toBe(404);
      expect((await handle(new Request(`${BASE}/p/${projects[n].key}/reports/${mine.id}`, { headers: { authorization: `Bearer ${projects[n].token}` } }))).status).toBe(404);
    }
    // The site's agent drains only its own queue.
    const first = await site(new Request('https://shipcue.example.com/api/shipcue/reports/next/claim', { method: 'POST', headers: { authorization: 'Bearer site-token' } }));
    expect((await first.json()).report.id).toBe(mine.id);
    expect((await site(new Request('https://shipcue.example.com/api/shipcue/reports/next/claim', { method: 'POST', headers: { authorization: 'Bearer site-token' } }))).status).toBe(204);
  });
});
