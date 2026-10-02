// The report button on every page of the site, so shipcue's own reports go through shipcue.
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ReportButton } from '../../src/react';
import { AREAS } from './areas.mjs';

function areaFor(path) {
  if (path.startsWith('/docs')) return 'docs';
  if (path.startsWith('/use-cases')) return 'use-cases';
  if (path.startsWith('/blog')) return 'blog';
  return 'home';
}

const el = document.createElement('div');
document.body.appendChild(el);
createRoot(el).render(
  createElement(ReportButton, {
    endpoint: '/api/shipcue',
    areas: AREAS,
    accentColor: '#16203A',
    captureErrors: true,
    diagnostics: () => ({ path: location.pathname, section: areaFor(location.pathname), width: innerWidth }),
  }),
);
