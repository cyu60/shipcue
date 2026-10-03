import { defineConfig } from 'tsup';

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
});
