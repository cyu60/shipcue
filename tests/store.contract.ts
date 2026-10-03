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
    describe('claims by people and agents', () => {
      const ada = { kind: 'person' as const, id: 'ada@example.com', name: 'Ada' };
      const bot = { kind: 'agent' as const, id: 'agent-1', name: 'claude-code' };
      const bot2 = { kind: 'agent' as const, id: 'agent-2', name: 'codex' };

      it('records who claimed it, a person or an agent', async () => {
        const r = await store.create(sample());
        const claimed = await store.claim(r.id, ada);
        expect(claimed).toMatchObject({ status: 'claimed', claimedBy: 'Ada', claimantKind: 'person', claimantId: 'ada@example.com', leaseExpiresAt: null });
        // A plain name still works, as an agent.
        const other = await store.create(sample());
        expect(await store.claim(other.id, 'mcp@laptop')).toMatchObject({ claimedBy: 'mcp@laptop', claimantKind: 'agent', claimantId: 'mcp@laptop' });
      });

      it('gives an agent claim a lease that a heartbeat renews and that runs out', async () => {
        const r = await store.create(sample());
        const claimed = await store.claim(r.id, bot, { leaseSeconds: 60 });
        expect(Date.parse(claimed!.leaseExpiresAt!)).toBeGreaterThan(Date.now() + 50_000);
        expect(await store.heartbeat!(r.id, bot2.id, 60)).toBeNull();
        expect(await store.heartbeat!(r.id, bot.id, 600)).not.toBeNull();
        expect(await store.expire!()).toEqual([]);
        const short = await store.create(sample());
        await store.claim(short.id, bot2, { leaseSeconds: -1 });
        const expired = await store.expire!();
        expect(expired.map((x) => x.id)).toEqual([short.id]);
        expect(await store.get(short.id)).toMatchObject({ status: 'open', claimedBy: null, claimantId: null, leaseExpiresAt: null });
        expect((await store.events!(short.id)).map((e) => e.action)).toEqual(['claimed', 'expired']);
      });

      it('queues a report assigned to an agent for that agent only', async () => {
        const top = await store.create(sample({ priority: 'blocking' }));
        const mine = await store.create(sample({ priority: 'low' }));
        const assigned = await store.assign!(mine.id, bot, ada);
        expect(assigned).toMatchObject({ status: 'open', claimantId: 'agent-1', claimedBy: 'claude-code', claimedAt: null });
        // Assigned work comes first, ahead of a more urgent unassigned report.
        expect((await store.claimNext(bot))?.id).toBe(mine.id);
        // Another agent cannot take it; it gets the unassigned one.
        expect(await store.claim(mine.id, bot2)).toBeNull();
        expect((await store.claimNext(bot2))?.id).toBe(top.id);
      });

      it('in push mode an agent only takes what was assigned to it', async () => {
        await store.create(sample());
        expect(await store.claimNext(bot, { pull: false })).toBeNull();
        const r = await store.create(sample());
        await store.assign!(r.id, bot, ada);
        expect((await store.claimNext(bot, { pull: false }))?.id).toBe(r.id);
      });

      it('claimNext keeps to the types an agent may take', async () => {
        await store.create(sample({ type: 'task', priority: 'blocking' }));
        const bug = await store.create(sample({ type: 'bug', priority: 'low' }));
        expect((await store.claimNext(bot, { types: ['bug', 'feature'] }))?.id).toBe(bug.id);
      });

      it('assigning to a person claims it for them; unassigning puts it back', async () => {
        const r = await store.create(sample());
        await store.claim(r.id, bot, { leaseSeconds: 60 });
        const handed = await store.assign!(r.id, ada, ada);
        expect(handed).toMatchObject({ status: 'claimed', claimantKind: 'person', claimedBy: 'Ada', leaseExpiresAt: null });
        // The agent that lost it can no longer close, release or renew it.
        expect(await store.close(r.id, 'fixed', 'x', { holder: bot.id })).toBeNull();
        expect(await store.release(r.id, { holder: bot.id })).toBeNull();
        expect(await store.heartbeat!(r.id, bot.id, 60)).toBeNull();
        const back = await store.assign!(r.id, null, ada);
        expect(back).toMatchObject({ status: 'open', claimantId: null, claimedBy: null });
      });

      it('review sets in_review with the PR link, and close keeps who did it', async () => {
        const r = await store.create(sample());
        await store.claim(r.id, bot, { leaseSeconds: 60 });
        expect(await store.review!(r.id, 'https://github.com/o/r/pull/2', { holder: bot2.id })).toBeNull();
        const inReview = await store.review!(r.id, 'https://github.com/o/r/pull/2', { holder: bot.id, by: bot });
        expect(inReview).toMatchObject({ status: 'in_review', prUrl: 'https://github.com/o/r/pull/2', leaseExpiresAt: null });
        // No lease while a PR waits, so it never expires.
        expect(await store.expire!()).toEqual([]);
        const closed = await store.close(r.id, 'fixed', 'merged', { holder: bot.id, by: bot });
        expect(closed).toMatchObject({ status: 'fixed', claimedBy: 'claude-code', prUrl: 'https://github.com/o/r/pull/2' });
        const reopened = await store.reopen!(r.id, ada);
        expect(reopened).toMatchObject({ status: 'open', claimedBy: null, resolution: null });
        expect((await store.events!(r.id)).map((e) => e.action)).toEqual(['claimed', 'review', 'closed', 'reopened']);
      });

      it('changes priority and logs who did what', async () => {
        const r = await store.create(sample({ priority: 'low' }));
        expect((await store.setPriority!(r.id, 'high', ada))?.priority).toBe('high');
        await store.assign!(r.id, bot, ada);
        const events = await store.events!(r.id);
        expect(events.map((e) => [e.action, e.actor?.name])).toEqual([['priority', 'Ada'], ['assigned', 'Ada']]);
        expect(events[1]?.detail).toMatchObject({ to: { kind: 'agent', id: 'agent-1', name: 'claude-code' } });
      });

      it('when two claimants race for one report, exactly one gets it', async () => {
        const r = await store.create(sample());
        const results = await Promise.all([store.claim(r.id, bot), store.claim(r.id, bot2), store.claimNext(ada)]);
        expect(results.filter(Boolean).length).toBe(1);
        expect((await store.events!(r.id)).filter((e) => e.action === 'claimed').length).toBe(1);
      });

      it('keeps notes in the history and leaves the report as it was (shipcue report 3d2dded6)', async () => {
        const r = await store.create(sample({ priority: 'low' }));
        await store.claim(r.id, bot);
        const before = (await store.get(r.id))!;
        const e = await store.note!(r.id, 'Steps:\n1. Open the page', bot);
        expect(e).toMatchObject({ reportId: r.id, action: 'note', actor: bot, detail: { text: 'Steps:\n1. Open the page' } });
        await store.note!(r.id, 'A person says hi', ada);
        const after = (await store.get(r.id))!;
        expect({ ...after, updatedAt: before.updatedAt }).toEqual(before);
        expect(after.updatedAt! >= before.updatedAt!).toBe(true);
        expect((await store.events!(r.id)).map((x) => [x.action, x.actor?.name, x.detail.text])).toEqual([
          ['claimed', 'claude-code', undefined],
          ['note', 'claude-code', 'Steps:\n1. Open the page'],
          ['note', 'Ada', 'A person says hi'],
        ]);
        expect(await store.note!('00000000-0000-4000-8000-000000000999', 'nobody', ada)).toBeNull();
      });

      it('lists one claimant\'s reports', async () => {
        const a = await store.create(sample());
        await store.create(sample());
        await store.claim(a.id, ada);
        expect((await store.list({ claimant: ada.id })).map((r) => r.id)).toEqual([a.id]);
      });
    });
  });
}
