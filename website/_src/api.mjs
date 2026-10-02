// The site's own shipcue queue: reports from the button on shipcue.ibuildathing.com.
import pg from 'pg';
import { createShipcueHandler, postgresStore } from '../../src/server';
import { resolveConfig } from '../../src/core';
import { AREAS } from './areas.mjs';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });

const handler = createShipcueHandler({
  store: postgresStore(pool),
  // Any file can come along with a report here, not just screenshots (report e8b2dedd).
  config: resolveConfig({ areas: AREAS, allowFiles: true }),
  basePath: '/api/shipcue',
  agentToken: process.env.SHIPCUE_TOKEN,
  // The Changelog page reads the queue and the fixes (no reporters or diagnostics).
  board: true,
  // shipcue's own board shows screenshots too (report 9fdd0b45).
  boardScreenshots: true,
  // Videos are uploaded to Vercel Blob by /api/shipcue-upload; only this store's report folders count.
  acceptVideoUrl: (url, id) => {
    const u = new URL(url);
    return u.hostname.endsWith('.public.blob.vercel-storage.com') && u.pathname.startsWith(`/videos/${id}/`);
  },
});

// vercel.json rewrites /api/shipcue/<rest> to /api/shipcue?__p=<rest>; put the path back.
function restore(req) {
  const url = new URL(req.url);
  const rest = url.searchParams.get('__p');
  if (rest === null) return req;
  url.searchParams.delete('__p');
  url.pathname = `/api/shipcue/${rest}`;
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(url, { method: req.method, headers: req.headers, body: hasBody ? req.body : undefined, duplex: 'half' });
}

export const GET = (req) => handler(restore(req));
export const POST = (req) => handler(restore(req));
