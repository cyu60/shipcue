// The site's own shipcue queue: reports from the button on shipcue.ibuildathing.com.
import pg from 'pg';
import { createShipcueHandler, emailReporter, postgresStore } from '../../src/server';
import { resolveConfig } from '../../src/core';
import { AREAS } from './areas.mjs';
import { cloudUserFrom, insforgeAuth } from './cloud.mjs';

// Who is signed in: a shipcue Cloud account, from the session cookie /app sets.
const auth = insforgeAuth(process.env.SHIPCUE_CLOUD_AUTH_URL);

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });

// Email whoever filed a report when it is fixed (InsForge emails on shipcue's project). Reporters
// here are signed-in shipcue Cloud accounts (getReporter below), so their addresses are real.
const EMAIL_KEY = process.env.SHIPCUE_EMAIL_API_KEY;
const sendEmail = async (m) => {
  const res = await fetch(`${process.env.SHIPCUE_CLOUD_AUTH_URL}/api/email/send-raw`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${EMAIL_KEY}` },
    body: JSON.stringify({ to: m.to, subject: m.subject, html: m.html, from: 'shipcue' }),
  });
  if (!res.ok) throw new Error(`email: ${res.status} ${(await res.text()).slice(0, 200)}`);
};

const handler = createShipcueHandler({
  // Only shipcue's own reports: the same table holds every Cloud project's, which must never show here.
  store: postgresStore(pool, 'shipcue_reports', { project: null }),
  // Any file can come along with a report here, not just screenshots (report e8b2dedd).
  config: resolveConfig({ areas: AREAS, allowFiles: true }),
  basePath: '/api/shipcue',
  broadcasters: EMAIL_KEY ? [emailReporter({ appName: 'shipcue', link: 'https://shipcue.ibuildathing.com/cuelog/', send: sendEmail })] : [],
  getReporter: async (req) => (await cloudUserFrom(req, auth))?.email ?? null,
  // Three reports without an account, then sign in (report dce33fd0); signed in, they can still send anonymously.
  anonymousLimit: Number(process.env.SHIPCUE_ANONYMOUS_LIMIT ?? 3),
  signInUrl: (req) => {
    const from = req.headers.get('referer');
    const path = from && new URL(from).origin === new URL(req.url).origin ? new URL(from).pathname : '/';
    return `/app/?next=${encodeURIComponent(path)}`;
  },
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
