import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { postgresStore } from '../src/server';
import { storeContract } from './store.contract';

const schema = readFileSync(new URL('../sql/schema.sql', import.meta.url), 'utf8');
const cloud = readFileSync(new URL('../sql/cloud.sql', import.meta.url), 'utf8');
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

storeContract('postgres', async () => {
  const db = new PGlite();
  await db.exec(schema);
  return postgresStore({ query: (text, params) => db.query(text, params) });
});

// The same contract, for one project in a shared (Cloud) table.
storeContract('postgres, one project of many', async () => {
  const db = new PGlite();
  await db.exec(schema);
  await db.exec(cloud);
  // Another project's reports sit in the same table and must never show up.
  const other = postgresStore({ query: (text, params) => db.query(text, params) }, 'shipcue_reports', { project: B });
  await other.create({ type: 'bug', priority: 'blocking', area: 'other', description: 'Someone else', pageUrl: '', userAgent: '', diagnostics: {}, screenshots: [], reporter: null });
  return postgresStore({ query: (text, params) => db.query(text, params) }, 'shipcue_reports', { project: A });
});

describe('postgres store, projects', () => {
  it("never reads, claims or closes another project's reports", async () => {
    const db = new PGlite();
    await db.exec(schema);
    await db.exec(cloud);
    const q = { query: (text: string, params?: unknown[]) => db.query(text, params) };
    const a = postgresStore(q, 'shipcue_reports', { project: A });
    const b = postgresStore(q, 'shipcue_reports', { project: B });
    const input = { type: 'bug' as const, priority: 'high' as const, area: 'other', description: 'Saving fails', pageUrl: '', userAgent: '', diagnostics: {}, screenshots: [], reporter: null };
    const inA = await a.create(input);
    expect(await b.get(inA.id)).toBeNull();
    expect(await b.list()).toEqual([]);
    expect(await b.claimNext('agent-b')).toBeNull();
    expect(await b.claim(inA.id, 'agent-b')).toBeNull();
    expect(await b.close(inA.id, 'fixed', 'not mine')).toBeNull();
    expect((await a.get(inA.id))?.status).toBe('open');
    expect(await a.version!()).not.toBe(await b.version!());
  });

  it("project: null is the app's own queue: it never sees, claims or counts a Cloud project's reports", async () => {
    const db = new PGlite();
    await db.exec(schema);
    await db.exec(cloud);
    const q = { query: (text: string, params?: unknown[]) => db.query(text, params) };
    const cloudProject = postgresStore(q, 'shipcue_reports', { project: A });
    const own = postgresStore(q, 'shipcue_reports', { project: null });
    const input = { type: 'bug' as const, priority: 'blocking' as const, area: 'other', description: 'A Cloud customer report', pageUrl: '', userAgent: '', diagnostics: {}, screenshots: [], reporter: null };
    const theirs = await cloudProject.create(input);
    await cloudProject.close(theirs.id, 'fixed', 'private fix');
    const mine = await own.create({ ...input, description: 'Our own report' });
    expect((await own.list()).map((r) => r.id)).toEqual([mine.id]);
    expect(await own.get(theirs.id)).toBeNull();
    expect(await own.close(theirs.id, 'wontfix', 'not ours')).toBeNull();
    expect((await own.claimNext('agent'))?.id).toBe(mine.id);
    expect(await own.version!()).not.toBe(await cloudProject.version!());
  });

  it('refuses a project that is not a uuid', () => {
    expect(() => postgresStore({ query: async () => ({ rows: [] }) }, 'shipcue_reports', { project: "x' OR 1=1" })).toThrow();
  });
});

describe('sql/schema.sql runs again safely', () => {
  it('re-applies over a history that already has every action, including edited and note', async () => {
    const db = new PGlite();
    await db.exec(schema);
    const store = postgresStore({ query: (text, params) => db.query(text, params) });
    const r = await store.create({ type: 'bug', priority: 'medium', area: 'other', description: 'Saving loses the last block', pageUrl: '', userAgent: '', diagnostics: {}, screenshots: [], reporter: null });
    await store.note!(r.id, 'looked at it', { kind: 'person', id: 'ada', name: 'Ada' });
    await store.edit!(r.id, { description: 'Saving loses the last block (offline)' }, { kind: 'person', id: 'ada', name: 'Ada' });
    await expect(db.exec(schema)).resolves.toBeDefined();
    await expect(db.exec(schema)).resolves.toBeDefined();
  });
});
