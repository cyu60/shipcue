import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'core/index': 'src/core/index.ts',
    'react/index': 'src/react/index.ts',
    'server/index': 'src/server/index.ts',
    'mcp/bin': 'src/mcp/bin.ts',
  },
  format: ['esm'],
  dts: { entry: { 'core/index': 'src/core/index.ts', 'react/index': 'src/react/index.ts', 'server/index': 'src/server/index.ts' } },
  clean: true,
  external: ['react', 'react-dom'],
  banner: ({ format }) => ({}),
});
