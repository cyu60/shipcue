import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import { adminUiVite } from './scripts/admin-ui.mjs';

const VERSION = JSON.parse(readFileSync('package.json', 'utf8')).version as string;

// Tests run in node; component tests opt into jsdom with
// `// @vitest-environment jsdom` at the top of the file.
export default defineConfig({
  // SHIPCUE_VERSION (src/core/version.ts), as the build sets it.
  define: { __SHIPCUE_VERSION__: JSON.stringify(VERSION) },
  // The admin page's script, as the build makes it (scripts/admin-ui.mjs).
  plugins: [adminUiVite(VERSION)],
  test: { globals: true, setupFiles: ['./vitest.setup.ts'] },
});
