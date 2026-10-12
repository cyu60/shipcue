// The site's Cloud positioning and pricing (Habitect report 2af9bd79): checks the built pages,
// which website/build.py writes and the repo commits.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const site = (path: string) => readFileSync(join(__dirname, '..', 'website', path, 'index.html'), 'utf8');
const prices = (html: string) => [...html.matchAll(/class="price"[^>]*>\$(\d+)/g)].map((m) => Number(m[1]));

describe('Cloud page', () => {
  const cloud = site('cloud');

  it('says who it is for: several Claude Code and Codex accounts and Mac minis', () => {
    expect(cloud).toMatch(/Claude Code/);
    expect(cloud).toMatch(/Codex/);
    expect(cloud).toMatch(/Mac mini/);
    expect(cloud).toMatch(/terminal/i);
  });

  it('lists plans from $10 to $50 a month under #pricing', () => {
    expect(cloud).toContain('id="pricing"');
    const p = prices(cloud);
    expect(p.length).toBeGreaterThanOrEqual(3);
    expect(Math.min(...p)).toBe(10);
    expect(Math.max(...p)).toBe(50);
  });

  it('keeps the beta honest: free while it lasts, self-hosting stays free', () => {
    expect(cloud).toMatch(/free while it lasts/i);
    expect(cloud).toMatch(/self-host/i);
  });
});

describe('Home and use cases point at Cloud', () => {
  it('home leads with the coordination layer and links to pricing', () => {
    const home = site('');
    expect(home).toMatch(/Mac mini/);
    expect(home).toContain('href="/cloud/#pricing"');
  });

  it('use cases no longer say Cloud is not built yet', () => {
    const uses = site('use-cases');
    expect(uses).not.toMatch(/not built yet/);
    expect(uses).toMatch(/Mac mini/);
  });
});
