import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const VERSION = JSON.parse(readFileSync('package.json', 'utf8')).version as string;

// Type declarations come from `tsc -p tsconfig.build.json` (see the build script).
export default defineConfig({
  entry: {
    'core/index': 'src/core/index.ts',
    'react/index': 'src/react/index.ts',
    'server/index': 'src/server/index.ts',
    'mcp/bin': 'src/mcp/bin.ts',
    'mcp/listen': 'src/mcp/listen.ts',
    'cli/bin': 'src/cli/bin.ts',
  },
  format: ['esm'],
  clean: true,
  external: ['react', 'react-dom'],
  // SHIPCUE_VERSION (src/core/version.ts) is package.json's version, set at build time.
  define: { __SHIPCUE_VERSION__: JSON.stringify(VERSION) },
});
