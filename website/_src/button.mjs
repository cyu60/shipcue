// The report button on every page of the site, so shipcue's own reports go through shipcue.
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ReportButton, openReport } from '../../src/react';
import { AREAS } from './areas.mjs';

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
    // Past reports, the queue and the changelog all live on one page (report e29431fc).
    pastReportsHref: '/changelog/',
    pastReportsLabel: 'Past reports & changelog',
    diagnostics: () => ({ path: location.pathname, section: areaFor(location.pathname), width: innerWidth }),
  }),
);
