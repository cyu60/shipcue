import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildDigest, createShipcueHandler, digest, emailDigest, formatDigest, memoryStore, slackDigest, type DigestMessage, type ReportStore } from '../src/server';
import type { ReportInput } from '../src/core';

const BASE = 'https://app.example.com/api/shipcue';
const at = (t: string) => vi.setSystemTime(new Date(t));
const input = (description: string, patch: Partial<ReportInput> = {}) => ({
  type: 'bug' as const,
  priority: 'high' as const,
  area: 'other',
  description,
  pageUrl: 'https://app.example.com/secret-page',
  userAgent: 'UA',
  diagnostics: { token: 'diag-secret-123' },
  reporter: 'ada@example.com',
  screenshots: [],
  ...patch,
});

/**
 * A history around the period 10:00–11:00 on 2026-10-03:
 * old (filed the day before, still open), early (filed 09:30, fixed 10:20 with a PR),
 * filedIn (filed 10:10), reopenedR (fixed yesterday, reopened 10:30), stuckR (claimed 09:00 with a
 * 30-minute lease, never renewed), expiredR (lease ran out and expired at 10:40), late (filed 11:05).
 */
async function seed() {
  vi.useFakeTimers();
  const store = memoryStore();
  at('2026-10-02T08:00:00Z');
  const old = await store.create(input('Oldest one: the sidebar flickers'));
  const reopenedR = await store.create(input('Export to PDF cuts the last page', { type: 'feature', priority: 'medium' }));
  await store.close(reopenedR.id, 'fixed', 'PDF export keeps every page');
  at('2026-10-03T09:00:00Z');
  const stuckR = await store.create(input('Search returns nothing for quotes'));
  await store.claim(stuckR.id, { kind: 'agent', id: 'a1', name: 'claude-code' }, { leaseSeconds: 1800 });
  const expiredR = await store.create(input('Dark mode loses the accent', { priority: 'low' }));
  await store.claim(expiredR.id, { kind: 'agent', id: 'a2', name: 'codex' }, { leaseSeconds: 60 });
  at('2026-10-03T09:30:00Z');
  const early = await store.create(input('Heading disappears on Enter (mail me at bob@example.com)'));
  at('2026-10-03T10:10:00Z');
  const filedIn = await store.create(input('Paste drops images', { type: 'task', priority: 'blocking' }));
  at('2026-10-03T10:20:00Z');
  await store.claim(early.id, 'claude-code');
  await store.close(early.id, 'fixed', 'Enter keeps the heading', { prUrl: 'https://github.com/acme/app/pull/7' });
  at('2026-10-03T10:30:00Z');
  await store.reopen!(reopenedR.id, null);
  at('2026-10-03T10:40:00Z');
  // expire() releases every lease that ran out; put stuckR back as still held, as a store that has not swept yet would.
  await store.expire!();
  await store.claim(stuckR.id, { kind: 'agent', id: 'a1', name: 'claude-code' }, { leaseSeconds: 60 });
  at('2026-10-03T11:05:00Z');
  const late = await store.create(input('Filed after the period'));
  return { store, old, early, filedIn, reopenedR, stuckR, expiredR, late };
}
const PERIOD = { since: '2026-10-03T10:00:00.000Z', until: '2026-10-03T11:00:00.000Z' };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('buildDigest', () => {
  it('summarises the period: filed, fixed with PR, reopened, stuck, still open, oldest waiting', async () => {
    const { store, early, filedIn, reopenedR, stuckR, expiredR, old } = await seed();
    const s = await buildDigest(store, PERIOD);
    expect(s.filed.map((i) => i.id)).toEqual([filedIn.id]);
    expect(s.fixed).toHaveLength(1);
    expect(s.fixed[0]).toMatchObject({ id: early.id, resolution: 'Enter keeps the heading', prUrl: 'https://github.com/acme/app/pull/7' });
    expect(s.reopened.map((i) => i.id)).toEqual([reopenedR.id]);
    const stuck = Object.fromEntries(s.stuck.map((i) => [i.id, i]));
    expect(stuck[expiredR.id]).toMatchObject({ returned: true, claimedBy: 'codex' });
    expect(stuck[stuckR.id]).toMatchObject({ returned: false, claimedBy: 'claude-code' });
    // old, reopenedR, stuckR (claimed), expiredR, filedIn, and late (filed after the period but open now).
    expect(s.stillOpen).toBe(6);
    expect(s.oldest?.id).toBe(old.id);
    expect(s.empty).toBe(false);
  });

  it('keeps to the period boundaries: since is in, until is out', async () => {
    const { store, filedIn, late } = await seed();
    expect((await buildDigest(store, { since: '2026-10-03T10:10:00.000Z', until: '2026-10-03T11:05:00.000Z' })).filed.map((i) => i.id)).toEqual([filedIn.id]);
    expect((await buildDigest(store, { since: '2026-10-03T11:00:00.000Z', until: '2026-10-03T12:00:00.000Z' })).filed.map((i) => i.id)).toEqual([late.id]);
    const before = await buildDigest(store, { since: '2026-10-03T08:00:00.000Z', until: '2026-10-03T09:00:00.000Z' });
    expect(before.filed).toEqual([]);
    expect(before.fixed).toEqual([]);
  });

  it('is empty when nothing happened', async () => {
    const { store } = await seed();
    const s = await buildDigest(store, { since: '2026-10-01T00:00:00.000Z', until: '2026-10-01T01:00:00.000Z' });
    expect(s.empty).toBe(true);
    expect(s.oldest).toBeNull();
  });

  it('works on a store without history, from the fixed reports', async () => {
    const { store, early } = await seed();
    const bare: ReportStore = { ...store, events: undefined };
    const s = await buildDigest(bare, PERIOD);
    expect(s.fixed.map((i) => i.id)).toEqual([early.id]);
    expect(s.reopened).toEqual([]);
  });
});

describe('formats', () => {
  it('never carries reporter emails, pages or diagnostics', async () => {
    const { store } = await seed();
    for (const format of ['slack', 'email', 'markdown'] as const) {
      const m = await digest(store, { ...PERIOD, format });
      const all = `${m.subject}\n${m.text}\n${m.html ?? ''}\n${JSON.stringify(m.summary)}`;
      expect(all).not.toContain('ada@example.com');
      expect(all).not.toContain('bob@example.com');
      expect(all).not.toContain('diag-secret-123');
      expect(all).not.toContain('secret-page');
      expect(all).not.toContain('UA');
    }
  });

  it('Slack: mrkdwn sections with the PR as a link', async () => {
    const { store } = await seed();
    const m = await digest(store, { ...PERIOD, format: 'slack', appName: 'Acme', link: 'https://app.example.com/reports' });
    expect(m.text).toContain('*Acme digest* · 2026-10-03 10:00–11:00 UTC');
    expect(m.text).toContain('*Filed (1)*\n• Agent task (blocking): Paste drops images');
    expect(m.text).toContain('Enter keeps the heading (Heading disappears on Enter (mail me at [email])) <https://github.com/acme/app/pull/7|PR>');
    expect(m.text).toContain('*Stuck past the lease (2)*');
    expect(m.text).toContain('Still open: 6. Oldest waiting (27h): Oldest one: the sidebar flickers');
    expect(m.text).toContain('<https://app.example.com/reports|Open the queue>');
    expect(m.subject).toBe('Acme digest: 1 filed, 1 fixed, 1 reopened, 2 stuck, 6 still open');
  });

  it('Markdown: one bullet list for a daily note or an outliner log', async () => {
    const { store } = await seed();
    const m = await digest(store, { ...PERIOD, format: 'markdown' });
    const lines = m.text.split('\n');
    expect(lines[0]).toBe('**shipcue digest** · 2026-10-03 10:00–11:00 UTC');
    expect(lines.slice(1).every((l) => l.startsWith('- ') || l.startsWith('  - '))).toBe(true);
    expect(m.text).toContain('- Fixed (1)\n  - Enter keeps the heading');
    expect(m.text).toContain('([PR](https://github.com/acme/app/pull/7))');
    expect(m.html).toBeUndefined();
  });

  it('email: a subject, plain text and escaped HTML', async () => {
    const { store } = await seed();
    await store.create(input('<script>alert(1)</script>'));
    const m = await digest(store, { since: PERIOD.since, until: '2026-10-03T12:00:00.000Z', format: 'email' });
    expect(m.subject).toMatch(/^shipcue digest: \d+ filed/);
    expect(m.text).toContain('Fixed (1)\n- Enter keeps the heading');
    expect(m.html).toContain('&lt;script&gt;');
    expect(m.html).not.toContain('<script>');
    expect(m.html).toContain('<a href="https://github.com/acme/app/pull/7">PR</a>');
  });

  it('says so when there was no activity', () => {
    const empty = { since: PERIOD.since, until: PERIOD.until, filed: [], fixed: [], reopened: [], stuck: [], stillOpen: 0, oldest: null, empty: true };
    expect(formatDigest(empty, 'slack').text).toContain('No new activity.');
    expect(formatDigest(empty, 'markdown').subject).toBe('shipcue digest: no new activity, 0 still open');
  });
});

describe('senders', () => {
  it('slackDigest posts the text; emailDigest hands over subject, html and text', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    const m: DigestMessage = { format: 'slack', subject: 's', text: 'hello', summary: {} as DigestMessage['summary'] };
    await slackDigest({ webhookUrl: 'https://hooks.slack.com/services/x' }).send(m);
    expect(JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string)).toEqual({ text: 'hello' });
    const sent: unknown[] = [];
    await emailDigest({ to: 'owner@example.com', send: async (e) => void sent.push(e) }).send({ ...m, format: 'email', html: '<p>hi</p>' });
    expect(sent).toEqual([{ to: 'owner@example.com', subject: 's', html: '<p>hi</p>', text: 'hello' }]);
  });
});

describe('POST {base}/digest', () => {
  const post = (body: unknown = {}, token = 'secret') =>
    new Request(`${BASE}/digest`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('is off unless the digest option is given', async () => {
    const res = await createShipcueHandler({ store: memoryStore(), agentToken: 'secret' })(post());
    expect(res.status).toBe(404);
  });

  it('needs the agent token (shared or an agent of its own)', async () => {
    const handle = createShipcueHandler({ store: memoryStore(), agentToken: 'secret', agents: async (t) => (t === 'own' ? { id: 'a', name: 'a' } : null), digest: {} });
    expect((await handle(post({}, 'wrong'))).status).toBe(401);
    expect((await handle(new Request(`${BASE}/digest`, { method: 'POST' }))).status).toBe(401);
    expect((await handle(post({}, 'own'))).status).toBe(200);
    expect((await handle(post())).status).toBe(200);
  });

  it('returns Markdown for the last period when there is no sender', async () => {
    const { store } = await seed();
    at('2026-10-03T11:00:00Z');
    const handle = createShipcueHandler({ store, agentToken: 'secret', digest: { every: 'hour' } });
    const data = await (await handle(post())).json();
    expect(data).toMatchObject({ sent: false, format: 'markdown', empty: false });
    expect(data.summary.since).toBe(PERIOD.since);
    expect(data.text).toContain('Paste drops images');
    expect(JSON.stringify(data)).not.toContain('ada@example.com');
  });

  it('sends through the sender, skipping empty periods unless sendEmpty', async () => {
    const { store } = await seed();
    const sent: DigestMessage[] = [];
    const send = { name: 'test', format: 'slack' as const, send: async (m: DigestMessage) => void sent.push(m) };
    at('2026-10-03T11:00:00Z');
    const handle = createShipcueHandler({ store, agentToken: 'secret', digest: { every: 'hour', send } });
    expect(await (await handle(post())).json()).toMatchObject({ sent: true, format: 'slack' });
    expect(sent[0]!.text).toContain('*Filed (1)*');
    // A quiet hour is not sent.
    expect(await (await handle(post({ since: '2026-10-01T00:00:00Z', until: '2026-10-01T01:00:00Z' }))).json()).toMatchObject({ sent: false, empty: true });
    expect(sent).toHaveLength(1);
    const always = createShipcueHandler({ store, agentToken: 'secret', digest: { send, sendEmpty: true } });
    expect(await (await always(post({ since: '2026-10-01T00:00:00Z', until: '2026-10-01T01:00:00Z' }))).json()).toMatchObject({ sent: true, empty: true });
  });

  it('defaults to a day and checks since and until', async () => {
    vi.useFakeTimers();
    at('2026-10-03T12:00:00Z');
    const handle = createShipcueHandler({ store: memoryStore(), agentToken: 'secret', digest: {} });
    expect((await (await handle(post())).json()).summary.since).toBe('2026-10-02T12:00:00.000Z');
    expect((await handle(post({ since: 'yesterday' }))).status).toBe(400);
    expect((await handle(post({ since: '2026-10-03T12:00:00Z', until: '2026-10-03T11:00:00Z' }))).status).toBe(400);
    expect((await (await handle(post({ every: 'hour' }))).json()).summary.since).toBe('2026-10-03T11:00:00.000Z');
  });
});
