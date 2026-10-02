// The report button on every page of the site, so shipcue's own reports go through shipcue.
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ReportButton, openReport } from '../../src/react';
import { upload } from '@vercel/blob/client';
import { AREAS } from './areas.mjs';

// Straight to Vercel Blob, then tell the queue where it is (report 04192848).
async function uploadVideo(id, blob) {
  const type = blob.type.split(';')[0];
  const ext = type === 'video/mp4' ? 'mp4' : type === 'video/quicktime' ? 'mov' : 'webm';
  const { url } = await upload(`videos/${id}/video.${ext}`, blob, {
    access: 'public',
    handleUploadUrl: '/api/shipcue-upload',
    contentType: type,
    multipart: blob.size > 8 * 1024 * 1024,
  });
  const res = await fetch(`/api/shipcue/reports/${id}/video`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Could not attach the video.');
}

function areaFor(path) {
  if (path.startsWith('/docs')) return 'docs';
  if (path.startsWith('/use-cases')) return 'use-cases';
  if (path.startsWith('/blog')) return 'blog';
  return 'home';
}

// The Contact page's buttons open the panel through this.
window.shipcue = { openReport };

const el = document.createElement('div');
document.body.appendChild(el);
createRoot(el).render(
  createElement(ReportButton, {
    endpoint: '/api/shipcue',
    areas: AREAS,
    accentColor: '#16203A',
    captureErrors: true,
    uploadVideo,
    // Past reports, the queue and the changelog all live on the CueLog (reports e29431fc, 90a3435e, 514f1b23).
    pastReportsHref: '/cuelog/',
    pastReportsLabel: 'See the CueLog',
    diagnostics: () => ({ path: location.pathname, section: areaFor(location.pathname), width: innerWidth }),
  }),
);
