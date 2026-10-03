import { describe, it, expect, vi } from 'vitest';
import { createShipcueHandler, memoryStore } from '../src/server';
import { altFragment, dataUrlName, resolveConfig, shotAlt, withShotAlt } from '../src/core';

// Alt text travels with each screenshot (shipcue report 58b727d9).
const BASE = 'https://app.example.com/api/shipcue';
const png = (bytes = 10) => new File([new Uint8Array(bytes)], 's.png', { type: 'image/png' });
function form(alts: string[], files: File[]) {
  const f = new FormData();
  for (const [k, v] of Object.entries({ type: 'bug', priority: 'high', area: 'other', description: 'Heading disappears on Enter' })) f.set(k, v);
  for (const file of files) f.append('screenshot', file);
  for (const a of alts) f.append('screenshotAlt', a);
  return f;
}
const post = (body: FormData) => new Request(BASE + '/reports', { method: 'POST', body });

describe('alt text on a screenshot', () => {
  it('is kept as ;alt= in a data URL and #alt= on a link, and read back from either', () => {
    const data = withShotAlt('data:image/png;base64,AAAA', 'The Save button, greyed out; 2 rows');
    expect(data).toBe('data:image/png;alt=The%20Save%20button%2C%20greyed%20out%3B%202%20rows;base64,AAAA');
    expect(shotAlt(data)).toBe('The Save button, greyed out; 2 rows');
    expect(withShotAlt(data, 'New')).toBe('data:image/png;alt=New;base64,AAAA');
    expect(withShotAlt(data, '')).toBe('data:image/png;base64,AAAA');
    const link = withShotAlt('https://cdn.example.com/a/1.png', 'A chart');
    expect(link).toBe('https://cdn.example.com/a/1.png#alt=A%20chart');
    expect(shotAlt(link)).toBe('A chart');
    expect(shotAlt('https://cdn.example.com/a/1.png')).toBeNull();
    expect(altFragment(data)).toBe('#alt=New'.replace('New', 'The%20Save%20button%2C%20greyed%20out%3B%202%20rows'));
    // A file name in the same data URL still reads.
    expect(dataUrlName('data:application/pdf;alt=x;name=log.pdf;base64,AA')).toBe('log.pdf');
  });

  it('is stored with the screenshot it belongs to, capped at maxAltText', async () => {
    const store = memoryStore();
    const handle = createShipcueHandler({ store, config: resolveConfig({ maxAltText: 10 }), basePath: '/api/shipcue', board: true, boardScreenshots: true });
    const { id } = await (await handle(post(form(['The heading is gone after Enter', ''], [png(12), png(5)])))).json();
    const saved = (await store.get(id))!;
    expect(shotAlt(saved.screenshots[0]!)).toBe('The headin');
    expect(shotAlt(saved.screenshots[1]!)).toBeNull();
    // The board links carry it as #alt=, and the route still serves the image.
    const board = await (await handle(new Request(BASE + '/board'))).json();
    expect(board.queue[0].screenshots[0]).toBe(`/api/shipcue/board/screenshot/${id}/0#alt=The%20headin`);
    const res = await handle(new Request(`${BASE}/board/screenshot/${id}/0`));
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(12);
    const caps = await (await handle(new Request(BASE + '/capabilities'))).json();
    expect(caps.maxAltText).toBe(10);
  });

  it('goes on a stored file as #alt=', async () => {
    const saveScreenshot = vi.fn(async (_f: File, key: string) => `https://cdn.example.com/${key}`);
    const store = memoryStore();
    const handle = createShipcueHandler({ store, config: resolveConfig(), basePath: '/api/shipcue', saveScreenshot });
    const { id } = await (await handle(post(form(['Empty table'], [png()])))).json();
    expect((await store.get(id))!.screenshots[0]).toMatch(/^https:\/\/cdn\.example\.com\/.+\.png#alt=Empty%20table$/);
  });
});
