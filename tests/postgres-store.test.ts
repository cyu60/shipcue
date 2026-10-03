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

describe('retry-safe filing in Postgres (shipcue report 9833fd28)', () => {
  const input = { type: 'bug' as const, priority: 'high' as const, area: 'other', description: 'Saving fails', pageUrl: '', userAgent: '', diagnostics: {}, screenshots: [], reporter: null };

  it('scopes a key to its project: the same key in two Cloud projects files two reports', async () => {
    const db = new PGlite();
    await db.exec(schema);
    await db.exec(cloud);
    const q = { query: (text: string, params?: unknown[]) => db.query(text, params) };
    const a = postgresStore(q, 'shipcue_reports', { project: A });
    const b = postgresStore(q, 'shipcue_reports', { project: B });
    const own = postgresStore(q, 'shipcue_reports', { project: null });
    const inA = await a.create({ ...input, idempotencyKey: 'same-key' });
    const inB = await b.create({ ...input, idempotencyKey: 'same-key' });
    const inOwn = await own.create({ ...input, idempotencyKey: 'same-key' });
    expect(new Set([inA.id, inB.id, inOwn.id]).size).toBe(3);
    expect([inA, inB, inOwn].every((r) => !r.replayed)).toBe(true);
    expect((await a.create({ ...input, idempotencyKey: 'same-key' })).id).toBe(inA.id);
    expect((await own.create({ ...input, idempotencyKey: 'same-key' })).id).toBe(inOwn.id);
    const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM shipcue_reports WHERE idempotency_key = 'same-key'`);
    expect(rows[0]!.n).toBe(3);
  });

  it('a table not yet upgraded (no idempotency_key column) still takes reports, without the protection', async () => {
    const db = new PGlite();
    await db.exec(schema);
    await db.exec('DROP INDEX IF EXISTS shipcue_reports_idempotency; DROP INDEX IF EXISTS shipcue_reports_idempotency_project; ALTER TABLE shipcue_reports DROP COLUMN idempotency_key;');
    const store = postgresStore({ query: (text, params) => db.query(text, params) });
    const one = await store.create({ ...input, idempotencyKey: 'k-old-table' });
    const two = await store.create({ ...input, idempotencyKey: 'k-old-table' });
    expect(one.id).not.toBe(two.id);
    expect((await store.list()).length).toBe(2);
  });

  it('sql/schema.sql and sql/cloud.sql re-run safely over rows that carry keys, in either order', async () => {
    const db = new PGlite();
    await db.exec(schema);
    const own = postgresStore({ query: (text, params) => db.query(text, params) });
    await own.create({ ...input, idempotencyKey: 'k1' });
    await db.exec(schema);
    await db.exec(cloud);
    await db.exec(schema);
    await db.exec(cloud);
    const q = { query: (text: string, params?: unknown[]) => db.query(text, params) };
    const a = postgresStore(q, 'shipcue_reports', { project: A });
    const b = postgresStore(q, 'shipcue_reports', { project: B });
    // Scoped per project after the upgrade, whichever file ran last.
    expect((await a.create({ ...input, idempotencyKey: 'k2' })).id).not.toBe((await b.create({ ...input, idempotencyKey: 'k2' })).id);
    const { rows } = await db.query<{ indexname: string }>(`SELECT indexname FROM pg_indexes WHERE tablename = 'shipcue_reports' AND indexname LIKE 'shipcue_reports_idempotency%' ORDER BY 1`);
    expect(rows.map((r) => r.indexname)).toEqual(['shipcue_reports_idempotency_project']);
  });

  it('refuses a key longer than 100 characters at the database', async () => {
    const db = new PGlite();
    await db.exec(schema);
    await expect(db.query(`INSERT INTO shipcue_reports (type, priority, area, description, idempotency_key) VALUES ('bug', 'low', 'other', 'x', $1)`, ['k'.repeat(101)])).rejects.toThrow();
  });
});
