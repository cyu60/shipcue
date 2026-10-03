import { describe, it, expect, vi } from 'vitest';
import { createShipcueHandler, emailReporter, memoryStore, type EmailMessage } from '../src/server';

const BASE = 'https://app.example.com/api/shipcue';
const sample = (reporter: string | null) => ({ type: 'bug' as const, priority: 'medium' as const, area: 'other', description: 'The <b>save</b> button does nothing', pageUrl: '', userAgent: '', diagnostics: {}, screenshots: [], reporter });

function setup(trust?: (r: string) => boolean) {
  const store = memoryStore();
  const sent: EmailMessage[] = [];
  const handle = createShipcueHandler({
    store,
    agentToken: 'secret',
    broadcasters: [emailReporter({ appName: 'Acme', link: 'https://acme.dev/cuelog', send: async (m) => void sent.push(m), ...(trust ? { trust } : {}) })],
  });
  const close = (id: string, status: 'fixed' | 'wontfix') =>
    handle(new Request(`${BASE}/reports/${id}/close`, { method: 'POST', headers: { authorization: 'Bearer secret', 'content-type': 'application/json' }, body: JSON.stringify({ status, resolution: 'Save works again <script>', prUrl: 'https://github.com/o/r/pull/4' }) }));
  return { store, sent, close };
}

describe('emailReporter: tell the reporter when it is fixed', () => {
  it('emails the reporter once it is fixed, escaped, with the fix and the PR', async () => {
    const { store, sent, close } = setup();
    const r = await store.create(sample('ada@example.com'));
    await close(r.id, 'fixed');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'ada@example.com', subject: 'Fixed: The <b>save</b> button does nothing' });
    expect(sent[0]!.html).toContain('Save works again &lt;script&gt;');
    expect(sent[0]!.html).toContain('href="https://github.com/o/r/pull/4"');
    expect(sent[0]!.html).not.toContain('<b>save</b>');
    expect(sent[0]!.text).toContain('https://acme.dev/cuelog');
  });

  it('stays quiet for won\'t fix, anonymous reports, and reporters it does not trust', async () => {
    const { store, sent, close } = setup((who) => who.endsWith('@trusted.dev'));
    const a = await store.create(sample('ada@example.com'));
    const b = await store.create(sample(null));
    const c = await store.create(sample('bo@trusted.dev'));
    await close(a.id, 'fixed');
    await close(b.id, 'fixed');
    await close(c.id, 'wontfix');
    expect(sent).toEqual([]);
  });

  it('a failing send never fails closing the report', async () => {
    const store = memoryStore();
    const handle = createShipcueHandler({ store, agentToken: 'secret', broadcasters: [emailReporter({ appName: 'Acme', send: vi.fn(async () => { throw new Error('SES down'); }) })] });
    const r = await store.create(sample('ada@example.com'));
    const res = await handle(new Request(`${BASE}/reports/${r.id}/close`, { method: 'POST', headers: { authorization: 'Bearer secret', 'content-type': 'application/json' }, body: JSON.stringify({ status: 'fixed' }) }));
    expect(res.status).toBe(200);
  });
});
