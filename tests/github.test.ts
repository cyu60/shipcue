// The GitHub webhook (shipcue report 919f5ca2): a PR that names a report moves it to In review,
// and merging it closes the report as fixed, or, with liveCheck, once production serves the merge.
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createShipcueHandler, memoryStore, postgresStore, reportIdsIn, verifyGitHubSignature, type HandlerOptions } from '../src/server';
import { resolveConfig } from '../src/core';

const BASE = 'https://app.example.com/api/shipcue';
const SECRET = 'gh-secret';
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

async function setup(opts: Partial<HandlerOptions> = {}, store = memoryStore()) {
  const handle = createShipcueHandler({ store, config: resolveConfig(), basePath: '/api/shipcue', github: { secret: SECRET }, ...opts });
  const file = (description = 'The save button does nothing') =>
    store.create({ type: 'bug', priority: 'high', area: 'other', description, pageUrl: '', userAgent: '', diagnostics: {}, reporter: null, screenshots: [] });
  return { store, handle, file };
}

const sign = (body: string, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
function hook(payload: unknown, opts: { event?: string; secret?: string; signature?: string | null } = {}) {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-github-event': opts.event ?? 'pull_request' };
  const sig = opts.signature === undefined ? sign(body, opts.secret) : opts.signature;
  if (sig !== null) headers['x-hub-signature-256'] = sig;
  return new Request(`${BASE}/github`, { method: 'POST', body, headers });
}
function pr(action: string, fields: { title?: string; body?: string; branch?: string; merged?: boolean; number?: number } = {}) {
  const number = fields.number ?? 12;
  return {
    action,
    number,
    sender: { login: 'ada' },
    pull_request: {
      number,
      html_url: `https://github.com/acme/app/pull/${number}`,
      title: fields.title ?? 'Fix the save button',
      body: fields.body ?? '',
      head: { ref: fields.branch ?? 'fix-save' },
      merged: fields.merged ?? false,
      merge_commit_sha: fields.merged ? SHA : null,
    },
  };
}

describe('verifyGitHubSignature', () => {
  it('takes only the sha256 HMAC of the exact body with the secret', () => {
    expect(verifyGitHubSignature(SECRET, '{"a":1}', sign('{"a":1}'))).toBe(true);
    expect(verifyGitHubSignature(SECRET, '{"a":2}', sign('{"a":1}'))).toBe(false);
    expect(verifyGitHubSignature(SECRET, '{"a":1}', sign('{"a":1}', 'other'))).toBe(false);
    expect(verifyGitHubSignature(SECRET, '{"a":1}', null)).toBe(false);
    expect(verifyGitHubSignature(SECRET, '{"a":1}', 'sha256=zz')).toBe(false);
  });
});

describe('reportIdsIn', () => {
  it('finds full ids and 8-character prefixes in titles, bodies and branch names', () => {
    const id = '919f5ca2-7723-476f-b635-a36dbb6a24e0';
    expect(reportIdsIn(`Fixes shipcue report ${id}`)).toEqual({ full: [id], prefixes: ['919f5ca2'] });
    expect(reportIdsIn('fix/919F5CA2-github-loop').prefixes).toEqual(['919f5ca2']);
    expect(reportIdsIn('shipcue-919f5ca2').prefixes).toEqual(['919f5ca2']);
    // Longer hex runs (a commit sha) and shorter ones are not ids.
    expect(reportIdsIn(`merged ${SHA} and abc1234`).prefixes).toEqual([]);
  });
});

describe('the GitHub webhook', () => {
  it('is off unless the github option is given', async () => {
    const { handle } = await setup({ github: undefined });
    expect((await handle(hook(pr('opened')))).status).toBe(404);
  });

  it('refuses requests without the right signature', async () => {
    const { handle, file } = await setup();
    const r = await file();
    expect((await handle(hook(pr('opened', { body: r.id }), { signature: null }))).status).toBe(401);
    expect((await handle(hook(pr('opened', { body: r.id }), { secret: 'wrong' }))).status).toBe(401);
  });

  it('answers ping and ignores other events', async () => {
    const { handle } = await setup();
    expect((await handle(hook({ zen: 'hi' }, { event: 'ping' }))).status).toBe(200);
    const res = await handle(hook({ ref: 'main' }, { event: 'push' }));
    expect(res.status).toBe(202);
  });

  it('a PR naming a report by full id or 8-character prefix moves it to In review with the PR link', async () => {
    const { store, handle, file } = await setup();
    const a = await file('First report');
    const b = await file('Second report');
    const res = await handle(hook(pr('opened', { title: `Fix ${a.id.slice(0, 8)}`, body: `Also closes ${b.id}` })));
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.moved.map((m: { id: string }) => m.id).sort()).toEqual([a.id, b.id].sort());
    for (const id of [a.id, b.id]) expect(await store.get(id)).toMatchObject({ status: 'in_review', prUrl: 'https://github.com/acme/app/pull/12' });
    const events = await store.events!(a.id);
    expect(events.at(-1)).toMatchObject({ action: 'review', actor: { kind: 'agent', id: 'github', name: 'github (@ada)' } });
  });

  it('reads the branch name too, and handles reopened, edited and synchronize', async () => {
    const { store, handle, file } = await setup();
    const a = await file();
    await handle(hook(pr('edited', { branch: `fix/${a.id.slice(0, 8)}-save` })));
    expect((await store.get(a.id))?.status).toBe('in_review');
    // Already in review: a new push changes nothing.
    const res = await handle(hook(pr('synchronize', { branch: `fix/${a.id.slice(0, 8)}-save` })));
    expect((await res.json()).moved).toEqual([]);
  });

  it('keeps a claimed report\'s claimant while it is in review', async () => {
    const { store, handle, file } = await setup();
    const a = await file();
    await store.claim(a.id, 'claude-code');
    await handle(hook(pr('opened', { body: a.id })));
    expect(await store.get(a.id)).toMatchObject({ status: 'in_review', claimantId: 'claude-code' });
  });

  it('ignores ids that are not reports in this store, and ambiguous prefixes', async () => {
    const { store, handle, file } = await setup();
    const a = await file();
    const res = await handle(hook(pr('opened', { body: `Fixes 00000000-0000-4000-8000-000000000000 and deadbeef` })));
    expect((await res.json()).moved).toEqual([]);
    expect((await store.get(a.id))?.status).toBe('open');
  });

  it('merging closes it as fixed with "Merged in #N" and the PR link', async () => {
    const { store, handle, file } = await setup();
    const a = await file();
    await handle(hook(pr('opened', { body: a.id })));
    await handle(hook(pr('closed', { body: a.id, merged: true })));
    expect(await store.get(a.id)).toMatchObject({ status: 'fixed', resolution: 'Merged in #12', prUrl: 'https://github.com/acme/app/pull/12' });
    expect((await store.events!(a.id)).at(-1)).toMatchObject({ action: 'closed', actor: { id: 'github' } });
  });

  it('a merge closes an open report it never saw opened, and leaves closed ones alone', async () => {
    const { store, handle, file } = await setup();
    const a = await file();
    const done = await file('Already done');
    await store.close(done.id, 'wontfix', 'Not doing it');
    await handle(hook(pr('closed', { body: `${a.id} ${done.id}`, merged: true })));
    expect((await store.get(a.id))?.status).toBe('fixed');
    expect(await store.get(done.id)).toMatchObject({ status: 'wontfix', resolution: 'Not doing it' });
  });

  it('closing a PR unmerged puts its in-review reports back in the queue', async () => {
    const { store, handle, file } = await setup();
    const a = await file();
    const other = await file('Reviewed under another PR');
    await handle(hook(pr('opened', { body: a.id })));
    await store.review!(other.id, 'https://github.com/acme/app/pull/99');
    await handle(hook(pr('closed', { body: `${a.id} ${other.id}`, merged: false })));
    expect(await store.get(a.id)).toMatchObject({ status: 'open', claimantId: null });
    // Only reports in review under this PR.
    expect((await store.get(other.id))?.status).toBe('in_review');
  });
});

describe('liveCheck', () => {
  function site(body: { text: string }) {
    const calls: string[] = [];
    const fetch = async (url: string) => {
      calls.push(url);
      return new Response(body.text);
    };
    return { calls, fetch };
  }

  it('waits for production to serve the merge before closing, then says "live in <sha7>"', async () => {
    const page = { text: '{"sha":"0000000"}' };
    const { calls, fetch } = site(page);
    const { store, handle, file } = await setup({ github: { secret: SECRET, liveCheck: { url: 'https://app.example.com/api/version', fetch } } });
    const a = await file();
    await handle(hook(pr('closed', { body: a.id, merged: true })));
    const merged = await store.get(a.id);
    expect(merged).toMatchObject({ status: 'in_review', prUrl: 'https://github.com/acme/app/pull/12' });
    expect(merged?.resolution).toContain(SHA);

    expect(await handle.checkLive()).toEqual([]);
    expect(calls).toEqual(['https://app.example.com/api/version']);
    expect((await store.get(a.id))?.status).toBe('in_review');

    page.text = `{"sha":"${SHA}"}`;
    const closed = await handle.checkLive();
    expect(closed.map((r) => r.id)).toEqual([a.id]);
    expect(await store.get(a.id)).toMatchObject({ status: 'fixed', resolution: `Merged in #12, live in ${SHA.slice(0, 7)}`, prUrl: 'https://github.com/acme/app/pull/12' });
  });

  it('takes a short sha or the app\'s own match', async () => {
    const page = { text: `version ${SHA.slice(0, 7)}` };
    const { fetch } = site(page);
    const { store, handle, file } = await setup({ github: { secret: SECRET, liveCheck: { url: 'https://app.example.com/v', fetch } } });
    const a = await file();
    await handle(hook(pr('closed', { body: a.id, merged: true })));
    expect((await handle.checkLive()).length).toBe(1);

    const custom = await setup({ github: { secret: SECRET, liveCheck: { url: 'https://app.example.com/v', fetch, match: (body) => body.includes('deployed') } } });
    const b = await custom.file();
    await custom.handle(hook(pr('closed', { body: b.id, merged: true })));
    expect(await custom.handle.checkLive()).toEqual([]);
    page.text = 'deployed';
    expect((await custom.handle.checkLive()).length).toBe(1);
    expect((await custom.store.get(b.id))?.status).toBe('fixed');
  });

  it('checks lazily on board reads, at most once per everyMs, and not at all with nothing waiting', async () => {
    const page = { text: 'old' };
    const { calls, fetch } = site(page);
    const { store, handle, file } = await setup({ board: true, github: { secret: SECRET, liveCheck: { url: 'https://app.example.com/v', fetch, everyMs: 60_000 } } });
    await handle(new Request(`${BASE}/board/version`));
    expect(calls).toEqual([]);
    const a = await file();
    await handle(hook(pr('closed', { body: a.id, merged: true })));
    await handle(new Request(`${BASE}/board`));
    expect(calls).toHaveLength(1);
    expect((await store.get(a.id))?.status).toBe('in_review');
    page.text = SHA;
    // Within everyMs: no second fetch yet.
    await handle(new Request(`${BASE}/board/version`));
    expect(calls).toHaveLength(1);
    expect((await store.get(a.id))?.status).toBe('in_review');
    // A cron calling checkLive() is not throttled.
    await handle.checkLive();
    expect((await store.get(a.id))?.status).toBe('fixed');
    // A new merge on this instance checks again on the next read.
    const b = await file('Second');
    await handle(hook(pr('closed', { body: b.id, merged: true, number: 13 })));
    await handle(new Request(`${BASE}/board/version`));
    expect(await store.get(b.id)).toMatchObject({ status: 'fixed', resolution: `Merged in #13, live in ${SHA.slice(0, 7)}` });
  });

  it('a version URL that fails leaves everything waiting', async () => {
    const fetch = async () => {
      throw new Error('down');
    };
    const { store, handle, file } = await setup({ github: { secret: SECRET, liveCheck: { url: 'https://app.example.com/v', fetch } } });
    const a = await file();
    await handle(hook(pr('closed', { body: a.id, merged: true })));
    expect(await handle.checkLive()).toEqual([]);
    expect((await store.get(a.id))?.status).toBe('in_review');
  });
});

describe('on the Postgres store', () => {
  it('opens, waits for the deploy and closes, with the history under github', async () => {
    const db = new PGlite();
    await db.exec(readFileSync(new URL('../sql/schema.sql', import.meta.url), 'utf8'));
    const page = { text: 'old' };
    const fetch = async () => new Response(page.text);
    const { store, handle, file } = await setup(
      { github: { secret: SECRET, liveCheck: { url: 'https://app.example.com/v', fetch } } },
      postgresStore({ query: (text, params) => db.query(text, params) }),
    );
    const a = await file();
    await handle(hook(pr('opened', { branch: `fix/${a.id.slice(0, 8)}` })));
    expect(await store.get(a.id)).toMatchObject({ status: 'in_review', prUrl: 'https://github.com/acme/app/pull/12' });
    await handle(hook(pr('closed', { branch: `fix/${a.id.slice(0, 8)}`, merged: true })));
    expect((await store.get(a.id))?.status).toBe('in_review');
    page.text = SHA;
    expect((await handle.checkLive()).map((r) => r.id)).toEqual([a.id]);
    expect(await store.get(a.id)).toMatchObject({ status: 'fixed', resolution: `Merged in #12, live in ${SHA.slice(0, 7)}` });
    expect((await store.events!(a.id)).map((e) => [e.action, e.actor?.id])).toEqual([
      ['review', 'github'],
      ['edited', 'github'],
      ['closed', 'github'],
    ]);
    // PGlite starts slowly on a cold run.
  }, 20_000);
});
