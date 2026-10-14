// The admin page's script (src/admin/ui/app.jsx, with React) as one minified string. createAdminHandler
// serves it at {base}/app.js with `page`; it reaches the handler as the module 'virtual:shipcue-admin-ui',
// made here for tsup (adminUiEsbuild) and vitest (adminUiVite).
import { build } from 'esbuild';

export const ADMIN_UI_MODULE = 'virtual:shipcue-admin-ui';

export async function bundleAdminUi(version) {
  const out = await build({
    entryPoints: ['src/admin/ui/app.jsx'],
    bundle: true,
    minify: true,
    write: false,
    format: 'iife',
    target: 'es2020',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"', __SHIPCUE_VERSION__: JSON.stringify(version) },
    logLevel: 'error',
  });
  return out.outputFiles[0].text;
}

const moduleOf = async (version) => `export default ${JSON.stringify(await bundleAdminUi(version))};`;

export const adminUiEsbuild = (version) => ({
  name: 'shipcue-admin-ui',
  setup(b) {
    b.onResolve({ filter: /^virtual:shipcue-admin-ui$/ }, (args) => ({ path: args.path, namespace: 'shipcue-admin-ui' }));
    b.onLoad({ filter: /.*/, namespace: 'shipcue-admin-ui' }, async () => ({ contents: await moduleOf(version), loader: 'js' }));
  },
});

export const adminUiVite = (version) => ({
  name: 'shipcue-admin-ui',
  resolveId: (id) => (id === ADMIN_UI_MODULE ? `\0${ADMIN_UI_MODULE}` : null),
  load: (id) => (id === `\0${ADMIN_UI_MODULE}` ? moduleOf(version) : null),
});
