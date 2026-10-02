// Videos from the site's report button go straight to Vercel Blob (past the 4.5 MB request
// limit on functions), then the button posts the URL to /api/shipcue (shipcue report 04192848).
// This only hands out an upload token for a report filed in the last 30 minutes with no video.
import pg from 'pg';
import { handleUpload } from '@vercel/blob/client';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const PATH = /^videos\/([0-9a-f-]{36})\/video\.(webm|mp4|mov)$/;
const WINDOW_MS = 30 * 60 * 1000;

export async function POST(req) {
  try {
    const body = await req.json();
    const result = await handleUpload({
      request: req,
      body,
      onBeforeGenerateToken: async (pathname) => {
        const m = PATH.exec(pathname);
        if (!m) throw new Error('Not a report video.');
        const { rows } = await pool.query('SELECT created_at, video FROM shipcue_reports WHERE id = $1 AND NOT is_deleted', [m[1]]);
        const r = rows[0];
        if (!r || r.video || Date.now() - new Date(r.created_at).getTime() > WINDOW_MS) throw new Error('This report cannot take a video.');
        return {
          allowedContentTypes: ['video/webm', 'video/mp4', 'video/quicktime'],
          maximumSizeInBytes: 40 * 1024 * 1024,
          addRandomSuffix: true,
        };
      },
    });
    return Response.json(result);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : 'Upload failed.' }, { status: 400 });
  }
}
