import { describe, it, expect, beforeEach } from 'vitest';
import type { ReportStore, NewReport } from '../src/server';

export const sample = (over: Partial<NewReport> = {}): NewReport => ({
  type: 'bug',
  priority: 'medium',
  area: 'other',
  description: 'Something broke on the page',
  pageUrl: 'https://app.example.com/x',
  userAgent: 'UA',
  diagnostics: { a: 1 },
  reporter: 'ada@example.com',
  screenshots: [],
  context: null,
  ...over,
});

/** Every store must pass the same behaviour checks. */
export function storeContract(name: string, makeStore: () => Promise<ReportStore>) {
  describe(`${name} store`, () => {
    let store: ReportStore;
    beforeEach(async () => {
      store = await makeStore();
    });

    it('keeps the context with the report', async () => {
      const store = await makeStore();
      const r = await store.create(sample({ context: '- a block\n  - its child' }));
      expect((await store.get(r.id))?.context).toBe('- a block\n  - its child');
    });

    it('creates an open report and reads it back', async () => {
      const r = await store.create(sample({ screenshots: ['data:image/png;base64,AAA'] }));
      expect(r.status).toBe('open');
      expect(r.claimedBy).toBeNull();
      expect(await store.get(r.id)).toEqual(r);
      expect(r.diagnostics).toEqual({ a: 1 });
      expect(r.screenshots).toEqual(['data:image/png;base64,AAA']);
    });

    it('lists by status in queue order', async () => {
      const low = await store.create(sample({ priority: 'low' }));
      const blocking = await store.create(sample({ priority: 'blocking' }));
      await store.close(low.id, 'fixed', 'done');
      const open = await store.create(sample({ priority: 'high' }));
      expect((await store.list({ status: 'open' })).map((r) => r.id)).toEqual([blocking.id, open.id]);
      expect((await store.list()).length).toBe(3);
    });

    it('claimNext takes the most urgent open report and never hands it out twice', async () => {
      await store.create(sample({ priority: 'low' }));
      const top = await store.create(sample({ priority: 'blocking' }));
      const first = await store.claimNext('claude-1');
      expect(first?.id).toBe(top.id);
      expect(first?.status).toBe('claimed');
      expect(first?.claimedBy).toBe('claude-1');
      const second = await store.claimNext('claude-2');
      expect(second?.id).not.toBe(top.id);
      expect(await store.claimNext('claude-3')).toBeNull();
    });

    it('claim only works on open reports', async () => {
      const r = await store.create(sample());
      expect((await store.claim(r.id, 'a'))?.claimedBy).toBe('a');
      expect(await store.claim(r.id, 'b')).toBeNull();
    });

    it('release puts a claimed report back in the queue', async () => {
      const r = await store.create(sample());
      await store.claim(r.id, 'a');
      const back = await store.release(r.id);
      expect(back?.status).toBe('open');
      expect(back?.claimedBy).toBeNull();
    });

    it('close records the outcome', async () => {
      const r = await store.create(sample());
      const closed = await store.close(r.id, 'fixed', 'https://github.com/o/r/pull/1');
      expect(closed?.status).toBe('fixed');
      expect(closed?.resolution).toBe('https://github.com/o/r/pull/1');
      expect(await store.close('00000000-0000-0000-0000-000000000000', 'fixed', null)).toBeNull();
    });

    it('returns null for an unknown id', async () => {
      expect(await store.get('00000000-0000-0000-0000-000000000000')).toBeNull();
    });

    it('attaches one video to a report, once', async () => {
      const r = await store.create(sample());
      expect(r.video).toBeNull();
      const withVideo = await store.attachVideo(r.id, 'https://cdn.example.com/v.webm');
      expect(withVideo?.video).toBe('https://cdn.example.com/v.webm');
      expect((await store.get(r.id))?.video).toBe('https://cdn.example.com/v.webm');
      expect(await store.attachVideo(r.id, 'https://cdn.example.com/other.webm')).toBeNull();
      expect(await store.attachVideo('00000000-0000-0000-0000-000000000000', 'x')).toBeNull();
    });
  });
}
