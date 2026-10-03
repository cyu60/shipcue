import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Tests run in node; component tests opt into jsdom with
// `// @vitest-environment jsdom` at the top of the file.
export default defineConfig({
  // SHIPCUE_VERSION (src/core/version.ts), as the build sets it.
  define: { __SHIPCUE_VERSION__: JSON.stringify(JSON.parse(readFileSync('package.json', 'utf8')).version) },
  test: { globals: true, setupFiles: ['./vitest.setup.ts'] },
});
