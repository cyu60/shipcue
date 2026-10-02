// The Changelog page: shipcue's own queue and fixes, through the package's ShipcueBoard.
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ShipcueBoard } from '../../src/react';

const el = document.getElementById('shipcue-board');
if (el) createRoot(el).render(createElement(ShipcueBoard, { endpoint: '/api/shipcue', accentColor: '#16203A' }));
