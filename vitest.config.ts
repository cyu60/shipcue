import { defineConfig } from 'vitest/config';

// Tests run in node; component tests opt into jsdom with
// `// @vitest-environment jsdom` at the top of the file.
export default defineConfig({
  test: { globals: true, setupFiles: ['./vitest.setup.ts'] },
});
