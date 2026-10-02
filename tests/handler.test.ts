import { describe, it, expect, vi } from 'vitest';
import { createShipcueHandler, memoryStore } from '../src/server';
import { resolveConfig } from '../src/core';

const BASE = 'https://app.example.com/api/shipcue';
const config = resolveConfig({ areas: [{ value: 'editor', label: 'Editor' }] });

function setup(opts: Partial<Parameters<typeof createShipcueHandler>[0]> = {}) {
  const store = memoryStore();
  const handle = createShipcueHandler({
    store,
    config,
    basePath: '/api/shipcue',
    getReporter: async () => 'ada@example.com',
    agentToken: 'secret',
    ...opts,
  });
  return { store, handle };
}

function reportForm(fields: Record<string, string> = {}, files: File[] = []) {
  const f = new FormData();
  const all = { type: 'bug', priority: 'high', area: 'editor', description: 'Heading disappears on Enter', ...fields };
  for (const [k, v] of Object.entries(all)) f.set(k, v);
  for (const file of files) f.append('screenshot', file);
  return f;
}
const png = (bytes = 10) => new File([new Uint8Array(bytes)], 's.png', { type: 'image/png' });
const post = (path: string, body?: BodyInit, headers: Record<string, string> = {}) =>
  new Request(BASE + path, { method: 'POST', body, headers });
const agent = { authorization: 'Bearer secret', 'content-type': 'application/json' };

describe('filing a report', () => {
  it('stores it with the reporter and returns its id', async () => {
    const { store, handle } = setup();
    const res = await handle(post('/reports', reportForm({ diagnostics: '{"blocks":3}' })));
    expect(res.status).toBe(201);
    const { id } = await res.json();
    const saved = await store.get(id);
    expect(saved).toMatchObject({ reporter: 'ada@example.com', priority: 'high', area: 'editor', diagnostics: { blocks: 3 } });
  });

  it('keeps screenshots as data URLs when no saveScreenshot is given', async () => {
    const { store, handle } = setup();
    const { id } = await (await handle(post('/reports', reportForm({}, [png()])))).json();
    expect((await store.get(id))?.screenshots[0]).toMatch(/^data:image\/png;base64,/);
  });

  it('uses saveScreenshot when given', async () => {
    const saveScreenshot = vi.fn(async (_f: File, key: string) => `https://cdn.example.com/${key}`);
    const { store, handle } = setup({ saveScreenshot });
    const { id } = await (await handle(post('/reports', reportForm({}, [png(), png()])))).json();
    expect((await store.get(id))?.screenshots).toHaveLength(2);
    expect(saveScreenshot.mock.calls[0]?.[1]).toMatch(/^[0-9a-f-]{36}\/1\.png$/);
  });

  it('rejects bad screenshots and bad fields with a readable error', async () => {
    const { handle } = setup();
    const gif = new File(['x'], 'a.svg', { type: 'image/svg+xml' });
    let res = await handle(post('/reports', reportForm({}, [gif])));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Screenshots must be PNG, JPG, WebP or GIF.' });
    res = await handle(post('/reports', reportForm({}, Array.from({ length: 11 }, () => png()))));
    expect(await res.json()).toEqual({ error: 'Up to 10 screenshots.' });
    res = await handle(post('/reports', reportForm({}, [png(6 * 1024 * 1024)])));
    expect(await res.json()).toEqual({ error: 'Each screenshot must be under 5 MB.' });
    res = await handle(post('/reports', reportForm({ description: 'short' })));
    expect(res.status).toBe(400);
  });

  it('turns away signed-out people when requireReporter is set', async () => {
    const { handle } = setup({ getReporter: async () => null, requireReporter: true });
    expect((await handle(post('/reports', reportForm()))).status).toBe(401);
  });

  it('calls onReport and still succeeds if it throws', async () => {
    const onReport = vi.fn(async () => {
      throw new Error('mail down');
    });
    const { handle } = setup({ onReport });
    const res = await handle(post('/reports', reportForm()));
    expect(res.status).toBe(201);
    expect(onReport).toHaveBeenCalledOnce();
  });
});

describe('the agent queue API', () => {
  it('needs the bearer token', async () => {
    const { handle } = setup();
    expect((await handle(new Request(BASE + '/reports'))).status).toBe(401);
    expect((await handle(new Request(BASE + '/reports', { headers: { authorization: 'Bearer nope' } }))).status).toBe(401);
  });

  it('is switched off when no agentToken is configured', async () => {
    const { handle } = setup({ agentToken: undefined });
    expect((await handle(new Request(BASE + '/reports', { headers: agent }))).status).toBe(404);
  });

  it('lists, claims, reads and closes reports', async () => {
    const { handle } = setup();
    await handle(post('/reports', reportForm({ priority: 'low' })));
    const { id: urgent } = await (await handle(post('/reports', reportForm({ priority: 'blocking' })))).json();

    const list = await (await handle(new Request(BASE + '/reports?status=open', { headers: agent }))).json();
    expect(list.reports.map((r: { id: string }) => r.id)[0]).toBe(urgent);

    const claimed = await (await handle(post('/reports/next/claim', JSON.stringify({ agent: 'claude' }), agent))).json();
    expect(claimed.report).toMatchObject({ id: urgent, status: 'claimed', claimedBy: 'claude' });
    expect(claimed.prompt).toContain('# Bug [Blocking] Editor:');

    const one = await (await handle(new Request(`${BASE}/reports/${urgent}`, { headers: agent }))).json();
    expect(one.report.id).toBe(urgent);

    const closed = await (
      await handle(post(`/reports/${urgent}/close`, JSON.stringify({ status: 'fixed', resolution: 'PR #4' }), agent))
    ).json();
    expect(closed.report).toMatchObject({ status: 'fixed', resolution: 'PR #4' });
  });

  it('returns 204 when nothing is open and 409 when a claim loses', async () => {
    const { handle } = setup();
    expect((await handle(post('/reports/next/claim', JSON.stringify({ agent: 'a' }), agent))).status).toBe(204);
    const { id } = await (await handle(post('/reports', reportForm()))).json();
    await handle(post(`/reports/${id}/claim`, JSON.stringify({ agent: 'a' }), agent));
    expect((await handle(post(`/reports/${id}/claim`, JSON.stringify({ agent: 'b' }), agent))).status).toBe(409);
    expect((await handle(post(`/reports/${id}/release`, '{}', agent))).status).toBe(200);
  });

  it('rejects an unknown close status', async () => {
    const { handle } = setup();
    const { id } = await (await handle(post('/reports', reportForm()))).json();
    expect((await handle(post(`/reports/${id}/close`, JSON.stringify({ status: 'open' }), agent))).status).toBe(400);
  });
});

describe('attaching a video', () => {
  const webm = (bytes = 100) => new File([new Uint8Array(bytes)], 'clip.webm', { type: 'video/webm' });
  const videoForm = (file: File) => {
    const f = new FormData();
    f.set('video', file);
    return f;
  };
  async function filed(opts: Partial<Parameters<typeof createShipcueHandler>[0]> = {}) {
    const saveVideo = vi.fn(async (_f: File, key: string) => `https://cdn.example.com/${key}`);
    const env = setup({ saveVideo, ...opts });
    const { id } = await (await env.handle(post('/reports', reportForm()))).json();
    return { ...env, id, saveVideo };
  }

  it('saves the video and links it to the report', async () => {
    const { store, handle, id, saveVideo } = await filed();
    const res = await handle(post(`/reports/${id}/video`, videoForm(webm())));
    expect(res.status).toBe(200);
    expect(saveVideo).toHaveBeenCalledWith(expect.any(File), `${id}/video.webm`);
    expect((await store.get(id))?.video).toBe(`https://cdn.example.com/${id}/video.webm`);
  });
  it('is off unless saveVideo is given', async () => {
    const { handle, id } = await filed({ saveVideo: undefined });
    expect((await handle(post(`/reports/${id}/video`, videoForm(webm())))).status).toBe(404);
  });
  it('takes only videos, within the size limit', async () => {
    const { handle, id } = await filed({ config: resolveConfig({ areas: [{ value: 'editor', label: 'Editor' }], maxVideoBytes: 50 }) });
    expect((await handle(post(`/reports/${id}/video`, videoForm(new File(['x'], 'a.pdf', { type: 'application/pdf' }))))).status).toBe(400);
    expect((await handle(post(`/reports/${id}/video`, videoForm(webm(100))))).status).toBe(400);
  });
  it('only lets the reporter attach it, once, soon after filing', async () => {
    const { handle, id } = await filed();
    const stranger = createShipcueHandler({
      store: (await filed()).store, config, basePath: '/api/shipcue', getReporter: async () => 'eve@example.com', saveVideo: async () => 'x',
    });
    expect((await stranger(post(`/reports/${id}/video`, videoForm(webm())))).status).toBe(404);
    expect((await handle(post(`/reports/${id}/video`, videoForm(webm())))).status).toBe(200);
    expect((await handle(post(`/reports/${id}/video`, videoForm(webm())))).status).toBe(409);
  });
  it('refuses another reporter on the same store', async () => {
    const { store, handle, id } = await filed();
    void handle;
    const eve = createShipcueHandler({ store, config, basePath: '/api/shipcue', getReporter: async () => 'eve@example.com', saveVideo: async () => 'x' });
    expect((await eve(post(`/reports/${id}/video`, videoForm(webm())))).status).toBe(403);
  });
  it('refuses videos for old reports', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { handle, id } = await filed();
    vi.setSystemTime(Date.now() + 31 * 60 * 1000);
    expect((await handle(post(`/reports/${id}/video`, videoForm(webm())))).status).toBe(403);
    vi.useRealTimers();
  });
});

describe('screenshots per report', () => {
  it('takes up to 10, but not more than the total a request can carry', async () => {
    const { store, handle } = setup();
    const ten = Array.from({ length: 10 }, () => png());
    const { id } = await (await handle(post('/reports', reportForm({}, ten)))).json();
    expect((await store.get(id))?.screenshots).toHaveLength(10);
    expect((await handle(post('/reports', reportForm({}, [...ten, png()])))).status).toBe(400);
    const big = Array.from({ length: 2 }, () => png(2.5 * 1024 * 1024));
    const res = await handle(post('/reports', reportForm({}, big)));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/add up to more than/);
  });
});

describe('the public board', () => {
  it('is off unless switched on', async () => {
    const { handle } = setup();
    expect((await handle(new Request(BASE + '/board'))).status).toBe(404);
  });

  it('lists the queue and a changelog of fixes, without reporters or diagnostics', async () => {
    const { handle } = setup({ board: true });
    const first = (await (await handle(post('/reports', reportForm({ diagnostics: '{"secret":1}' })))).json()).id;
    const second = (await (await handle(post('/reports', reportForm({ type: 'feature', description: 'Dark mode please' })))).json()).id;
    await handle(post(`/reports/${first}/close`, JSON.stringify({ status: 'fixed', resolution: 'Headings keep their text (PR #9)' }), agent));
    const board = await (await handle(new Request(BASE + '/board'))).json();
    expect(board.queue.map((r: { id: string }) => r.id)).toEqual([second]);
    expect(board.changelog).toHaveLength(1);
    expect(board.changelog[0]).toMatchObject({ id: first, resolution: 'Headings keep their text (PR #9)', status: 'fixed' });
    const text = JSON.stringify(board);
    expect(text).not.toMatch(/ada@example.com|secret|diagnostics|reporter/);
  });

  it('leaves screenshots off the board unless boardScreenshots is on', async () => {
    const { handle } = setup({ board: true });
    const id = (await (await handle(post('/reports', reportForm({}, [png()])))).json()).id;
    const board = await (await handle(new Request(BASE + '/board'))).json();
    expect(board.queue[0].screenshots).toBeUndefined();
    expect((await handle(new Request(`${BASE}/board/screenshot/${id}/0`))).status).toBe(404);
  });

  it('with boardScreenshots, links each screenshot and serves it as an image only', async () => {
    const { handle } = setup({ board: true, boardScreenshots: true });
    const id = (await (await handle(post('/reports', reportForm({}, [png(12), png(5)])))).json()).id;
    const board = await (await handle(new Request(BASE + '/board'))).json();
    const path = new URL(BASE).pathname;
    expect(board.queue[0].screenshots).toEqual([`${path}/board/screenshot/${id}/0`, `${path}/board/screenshot/${id}/1`]);
    expect(JSON.stringify(board)).not.toMatch(/data:/);
    const res = await handle(new Request(`${BASE}/board/screenshot/${id}/0`));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await res.arrayBuffer()).byteLength).toBe(12);
    expect((await handle(new Request(`${BASE}/board/screenshot/${id}/7`))).status).toBe(404);
    // Closed as won't fix: off the board, so its screenshots are too.
    await handle(post(`/reports/${id}/close`, JSON.stringify({ status: 'wontfix', resolution: 'no' }), agent));
    expect((await handle(new Request(`${BASE}/board/screenshot/${id}/0`))).status).toBe(404);
  });

  it('can be limited per request', async () => {
    const { handle } = setup({ board: (req) => req.headers.get('cookie') === 'admin=1' });
    expect((await handle(new Request(BASE + '/board'))).status).toBe(404);
    expect((await handle(new Request(BASE + '/board', { headers: { cookie: 'admin=1' } }))).status).toBe(200);
  });
});
