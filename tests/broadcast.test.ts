import { describe, it, expect, vi, afterEach } from 'vitest';
import { broadcast, createShipcueHandler, memoryStore, signBody, slack, webhook, type Broadcaster, type ShipcueEvent } from '../src/server';
import { resolveConfig, type Report } from '../src/core';
import { diffReports } from '../src/mcp/events';

const BASE = 'https://app.example.com/api/shipcue';
const report = (patch: Partial<Report> = {}): Report => ({
  id: 'r1',
  type: 'bug',
  priority: 'high',
  area: 'other',
  description: 'The heading disappears on Enter',
  pageUrl: '',
  userAgent: '',
  diagnostics: {},
  context: null,
  screenshots: [],
  reporter: 'ada@example.com',
  status: 'open',
  createdAt: '2026-10-02T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
  claimedBy: null,
  claimedAt: null,
  resolution: null,
  video: null,
  ...patch,
});
const event = (patch: Partial<ShipcueEvent> = {}): ShipcueEvent => ({ type: 'report.filed', at: '2026-10-02T00:00:00.000Z', report: report(), ...patch });

afterEach(() => vi.restoreAllMocks());

describe('broadcasters', () => {
  it('webhook posts the event as JSON, signed when given a secret', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    await webhook({ url: 'https://agent.tailnet.ts.net/hook', secret: 's3cret' }).send(event());
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://agent.tailnet.ts.net/hook');
    const headers = init!.headers as Record<string, string>;
    expect(headers['x-shipcue-event']).toBe('report.filed');
    expect(headers['x-shipcue-signature']).toBe(signBody('s3cret', init!.body as string));
    const body = JSON.parse(init!.body as string);
    expect(body).toMatchObject({ type: 'report.filed', report: { id: 'r1' }, text: 'Bug filed (high): The heading disappears on Enter' });
  });

  it('slack sends one short line, without who filed it', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    await slack({ webhookUrl: 'https://hooks.slack.com/x', link: 'https://app.example.com/reports' }).send(
      event({ type: 'report.closed', report: report({ status: 'fixed', resolution: 'Headings keep their text' }) }),
    );
    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(body.text).toBe('Fixed: Headings keep their text <https://app.example.com/reports|Open>');
    expect(body.text).not.toContain('ada@example.com');
  });

  it('sends each event only to the broadcasters that want it, and a failing or slow one never blocks the rest', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const got: string[] = [];
    const ok = (name: string, events?: ShipcueEvent['type'][]): Broadcaster => ({ name, events, send: async (e) => void got.push(`${name}:${e.type}`) });
    const broken: Broadcaster = { name: 'broken', send: async () => Promise.reject(new Error('down')) };
    const slow: Broadcaster = { name: 'slow', send: () => new Promise(() => {}) };
    await broadcast([ok('all'), ok('closed-only', ['report.closed']), broken, slow], event(), 50);
    expect(got).toEqual(['all:report.filed']);
  });
});

describe('the handler broadcasts what happens to a report', () => {
  it('filed, claimed, released and closed', async () => {
    const seen: string[] = [];
    const store = memoryStore();
    const handle = createShipcueHandler({
      store,
      config: resolveConfig(),
      basePath: '/api/shipcue',
      agentToken: 'secret',
      broadcasters: [{ name: 'test', send: async (e) => void seen.push(`${e.type}:${e.report.status}`) }],
    });
    const form = new FormData();
    form.set('type', 'bug');
    form.set('description', 'The heading disappears on Enter');
    const id = (await (await handle(new Request(BASE + '/reports', { method: 'POST', body: form }))).json()).id;
    const agent = (path: string, body: unknown = {}) =>
      handle(new Request(BASE + path, { method: 'POST', headers: { authorization: 'Bearer secret', 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    await agent(`/reports/${id}/claim`, { agent: 'claude' });
    await agent(`/reports/${id}/release`);
    await agent(`/reports/${id}/close`, { status: 'fixed', resolution: 'done' });
    expect(seen).toEqual(['report.filed:open', 'report.claimed:claimed', 'report.released:open', 'report.closed:fixed']);
  });
});

describe('shipcue-listen: what changed between two looks', () => {
  it('turns differences into events, oldest report first', () => {
    const before = new Map([
      ['a', report({ id: 'a', status: 'open' })],
      ['b', report({ id: 'b', status: 'claimed' })],
      ['c', report({ id: 'c', status: 'claimed' })],
    ]);
    const now = [
      report({ id: 'a', status: 'claimed', claimedBy: 'claude' }),
      report({ id: 'b', status: 'open', video: 'https://x/v.webm' }),
      report({ id: 'c', status: 'fixed', resolution: 'done' }),
      report({ id: 'd', createdAt: '2026-10-03T00:00:00.000Z' }),
    ];
    expect(diffReports(before, now).map((c) => `${c.report.id}:${c.type}`)).toEqual([
      'a:report.claimed',
      'b:report.released',
      'b:report.video',
      'c:report.closed',
      'd:report.filed',
    ]);
    expect(diffReports(new Map(now.map((r) => [r.id, r])), now)).toEqual([]);
  });
  it('hears a report queued for an agent as assigned (shipcue report 3d2dded6)', () => {
    const before = new Map([['a', report({ id: 'a', status: 'open' })]]);
    const now = [report({ id: 'a', status: 'open', claimantKind: 'agent', claimantId: 'agent-1', claimedBy: 'mac-mini' })];
    expect(diffReports(before, now).map((c) => c.type)).toEqual(['report.assigned']);
    expect(diffReports(new Map(now.map((r) => [r.id, r])), now)).toEqual([]);
  });
});
