// The Vercel function behind /api/cloud/...: shipcue Cloud (see cloud.mjs).
import pg from 'pg';
import { createCloudHandler, insforgeAuth } from './cloud.mjs';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const handler = createCloudHandler({
  db: pool,
  // InsForge auth on shipcue's own project, e.g. https://<appkey>.us-east.insforge.app
  auth: insforgeAuth(process.env.SHIPCUE_CLOUD_AUTH_URL),
  base: '/api/cloud',
  // Invite-only beta: the emails that may create projects, comma-separated.
  beta: (process.env.SHIPCUE_CLOUD_BETA ?? '').split(','),
});

// vercel.json sends /api/cloud/<rest> here as ?__p=<rest>; put the path back.
function restore(req) {
  const url = new URL(req.url);
  const rest = url.searchParams.get('__p');
  if (rest === null) return req;
  url.searchParams.delete('__p');
  url.pathname = `/api/cloud/${rest}`;
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(url, { method: req.method, headers: req.headers, body: hasBody ? req.body : undefined, duplex: 'half' });
}

export const GET = (req) => handler(restore(req));
export const POST = (req) => handler(restore(req));
export const OPTIONS = (req) => handler(restore(req));
