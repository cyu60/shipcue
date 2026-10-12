import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * CommonJS loaders (Playwright specs, Jest) resolve with the `require` condition; an export
 * that names only `import` makes them fail with "Package subpath is not defined by exports"
 * (Habitect reports 062c7a76, e2c501aa). Each entry also gives `default`.
 */
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

describe('package exports', () => {
  it.each(['.', './react', './server'])('%s has a default condition beside import', (entry) => {
    const conditions = pkg.exports[entry];
    expect(conditions.default).toBe(conditions.import);
    expect(Object.keys(conditions).at(-1)).toBe('default');
  });
});
