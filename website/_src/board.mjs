// The CueLog page: shipcue's own queue and fixes, through the package's ShipcueBoard. It opens on
// the Changelog (report 2c9034d0).
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ShipcueBoard } from '../../src/react';

const el = document.getElementById('shipcue-board');
if (el) createRoot(el).render(createElement(ShipcueBoard, { endpoint: '/api/shipcue', accentColor: '#16203A', initialView: 'changelog' }));
