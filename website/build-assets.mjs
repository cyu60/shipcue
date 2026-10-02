// Bundles the site's report button and API function from the package source.
// Run from the repo root: node website/build-assets.mjs
import { build } from 'esbuild';

await build({
  entryPoints: ['website/_src/button.mjs'],
  outfile: 'website/assets/shipcue-button.js',
  bundle: true, minify: true, format: 'iife', target: 'es2020',
  define: { 'process.env.NODE_ENV': '"production"' },
});
await build({
  entryPoints: ['website/_src/api.mjs'],
  outfile: 'website/api/shipcue.mjs',
  bundle: true, platform: 'node', format: 'esm', target: 'node20', external: ['pg'],
});
console.log('assets built');
