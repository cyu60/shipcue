// Bundles the site's report button and API function from the package source.
// Run from the repo root: node website/build-assets.mjs
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const VERSION = JSON.parse(readFileSync('package.json', 'utf8')).version;

await build({
  entryPoints: ['website/_src/button.mjs'],
  outfile: 'website/assets/shipcue-button.js',
  bundle: true, minify: true, format: 'iife', target: 'es2020',
  define: { 'process.env.NODE_ENV': '"production"' },
});
await build({
  entryPoints: ['website/_src/board.mjs'],
  outfile: 'website/assets/shipcue-board.js',
  bundle: true, minify: true, format: 'iife', target: 'es2020',
  define: { 'process.env.NODE_ENV': '"production"' },
});
await build({
  entryPoints: ['website/_src/api.mjs'],
  outfile: 'website/api/shipcue.mjs',
  bundle: true, platform: 'node', format: 'esm', target: 'node20', external: ['pg'],
});
await build({
  entryPoints: ['website/_src/upload.mjs'],
  outfile: 'website/api/shipcue-upload.mjs',
  bundle: true, platform: 'node', format: 'esm', target: 'node20', external: ['pg', '@vercel/blob'],
});
await build({
  entryPoints: ['website/_src/app.jsx'],
  outfile: 'website/assets/shipcue-app.js',
  bundle: true, minify: true, format: 'iife', target: 'es2020', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"', __SHIPCUE_VERSION__: JSON.stringify(VERSION) },
});
await build({
  entryPoints: ['website/_src/cloud-api.mjs'],
  outfile: 'website/api/cloud.mjs',
  bundle: true, platform: 'node', format: 'esm', target: 'node20', external: ['pg'],
});
console.log('assets built');
