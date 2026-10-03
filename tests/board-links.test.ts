import { describe, it, expect, vi } from 'vitest';
import { createShipcueHandler, memoryStore, publicGitHubLinks } from '../src/server';
import { sample } from './store.contract';

const BASE = 'https://app.example.com/api/shipcue';
const gh = (privateRepos: string[]) =>
  vi.fn(async (url: string) => {
    const repo = url.replace('https://api.github.com/repos/', '');
    return privateRepos.includes(repo) ? new Response('{"message":"Not Found"}', { status: 404 }) : new Response(JSON.stringify({ private: false }));
  });

async function setup(opts: Parameters<typeof createShipcueHandler>[0]['boardLinks'], boardAdmin?: (req: Request) => boolean) {
  const store = memoryStore();
  const pub = await store.create(sample({ description: 'Public fix' }));
  await store.close(pub.id, 'fixed', 'Fixed in https://github.com/o/open/pull/7', { prUrl: null });
  const priv = await store.create(sample({ description: 'Private fix' }));
  await store.close(priv.id, 'fixed', 'Done', { prUrl: 'https://github.com/o/secret/pull/2' });
  const handle = createShipcueHandler({ store, board: true, boardLinks: opts, ...(boardAdmin ? { boardAdmin } : {}) });
  const board = async (headers: Record<string, string> = {}) => (await (await handle(new Request(`${BASE}/board`, { headers }))).json()).changelog as { description: string; prUrl?: string }[];
  return { board };
}

describe('GitHub links on the changelog (report dae35160)', () => {
  it('shows the link when the repository is public, never when it is private', async () => {
    const fetchImpl = gh(['o/secret']);
    const { board } = await setup(publicGitHubLinks({ fetch: fetchImpl }));
    const items = await board();
    expect(items.find((i) => i.description === 'Public fix')?.prUrl).toBe('https://github.com/o/open/pull/7');
    expect(items.find((i) => i.description === 'Private fix')?.prUrl).toBeUndefined();
    // Each repository is looked up once, then remembered.
    await board();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('shows every link to an admin', async () => {
    const { board } = await setup(publicGitHubLinks({ fetch: gh(['o/secret']) }), (req) => req.headers.get('x-admin') === '1');
    const items = await board({ 'x-admin': '1' });
    expect(items.find((i) => i.description === 'Private fix')?.prUrl).toBe('https://github.com/o/secret/pull/2');
  });

  it('shows no links when the option is off, and a lookup that fails hides the link', async () => {
    expect((await (await setup(false)).board()).every((i) => !i.prUrl)).toBe(true);
    const failing = publicGitHubLinks({ fetch: async () => { throw new Error('offline'); } });
    expect((await (await setup(failing)).board()).every((i) => !i.prUrl)).toBe(true);
  });
});
