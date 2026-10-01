import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { postgresStore } from '../src/server';
import { storeContract } from './store.contract';

const schema = readFileSync(new URL('../sql/schema.sql', import.meta.url), 'utf8');

storeContract('postgres', async () => {
  const db = new PGlite();
  await db.exec(schema);
  return postgresStore({ query: (text, params) => db.query(text, params) });
});
