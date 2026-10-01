import { describe, it, expect } from 'vitest';
import {
  buildTitle,
  buildBody,
  validateReport,
  sortQueue,
  toAgentPrompt,
  resolveConfig,
  type Report,
} from '../src/core';

const config = resolveConfig({
  areas: [
    { value: 'editor', label: 'Editor' },
    { value: 'sign-in', label: 'Sign-in' },
  ],
});

describe('resolveConfig', () => {
  it('always offers an Other area and keeps the defaults for limits', () => {
    expect(config.areas.map((a) => a.value)).toEqual(['editor', 'sign-in', 'other']);
    expect(config.maxScreenshots).toBe(3);
    expect(config.minLength).toBe(10);
  });
  it('does not add Other twice', () => {
    const c = resolveConfig({ areas: [{ value: 'other', label: 'Something else' }] });
    expect(c.areas).toEqual([{ value: 'other', label: 'Something else' }]);
  });
});

describe('validateReport', () => {
  const good = { type: 'bug', priority: 'high', area: 'editor', description: 'Enter at the end of a heading loses it' };

  it('accepts a good report and trims the text', () => {
    const r = validateReport({ ...good, description: '  ' + good.description + '  ' }, config);
    expect(r).toEqual({
      ok: true,
      value: { ...good, pageUrl: '', userAgent: '', diagnostics: {} },
    });
  });
  it('defaults priority to medium and area to other', () => {
    const r = validateReport({ type: 'feature', description: 'Let me nest pages under pages' }, config);
    expect(r.ok && r.value.priority).toBe('medium');
    expect(r.ok && r.value.area).toBe('other');
  });
  it('rejects short, long, unknown type, priority and area', () => {
    expect(validateReport({ ...good, description: 'too short' }, config)).toEqual({
      ok: false,
      error: 'Tell us a little more (at least 10 characters).',
    });
    expect(validateReport({ ...good, description: 'a'.repeat(4001) }, config).ok).toBe(false);
    expect(validateReport({ ...good, type: 'idea' }, config).ok).toBe(false);
    expect(validateReport({ ...good, priority: 'urgent' }, config).ok).toBe(false);
    expect(validateReport({ ...good, area: 'billing' }, config).ok).toBe(false);
  });
  it('clips page url and user agent and drops non-object diagnostics', () => {
    const r = validateReport({ ...good, pageUrl: 'x'.repeat(900), userAgent: 'u'.repeat(900), diagnostics: 'nope' }, config);
    expect(r.ok && r.value.pageUrl.length).toBe(500);
    expect(r.ok && r.value.userAgent.length).toBe(300);
    expect(r.ok && r.value.diagnostics).toEqual({});
  });
  it('rejects diagnostics bigger than 64 KB', () => {
    const r = validateReport({ ...good, diagnostics: { log: 'x'.repeat(70_000) } }, config);
    expect(r).toEqual({ ok: false, error: 'Diagnostics must be under 64 KB.' });
  });
});

describe('buildTitle', () => {
  it('reads Type [Priority] Area: first line', () => {
    expect(buildTitle({ type: 'bug', priority: 'high', area: 'editor', description: 'Heading lost\nmore' }, config)).toBe(
      'Bug [High] Editor: Heading lost',
    );
    expect(buildTitle({ type: 'feature', priority: 'low', area: 'other', description: 'Nest pages' }, config)).toBe(
      'Feature [Low] Other: Nest pages',
    );
  });
  it('cuts the headline at 60 characters', () => {
    expect(buildTitle({ type: 'bug', priority: 'low', area: 'other', description: 'a'.repeat(80) }, config)).toBe(
      `Bug [Low] Other: ${'a'.repeat(60)}…`,
    );
  });
});

const report: Report = {
  id: 'r1',
  type: 'bug',
  priority: 'high',
  area: 'editor',
  description: 'Enter at the end of a heading loses the heading',
  pageUrl: 'https://app.example.com/page/1',
  userAgent: 'UA',
  diagnostics: { blocks: 12, lastAction: 'split-block' },
  screenshots: ['https://cdn.example.com/1.png'],
  reporter: 'ada@example.com',
  status: 'open',
  createdAt: '2026-10-01T10:00:00.000Z',
  claimedBy: null,
  claimedAt: null,
  resolution: null,
};

describe('buildBody', () => {
  it('puts the text first, then screenshots, then the details', () => {
    expect(buildBody(report, config)).toBe(
      [
        'Enter at the end of a heading loses the heading',
        '',
        'Screenshots:',
        'https://cdn.example.com/1.png',
        '',
        '---',
        'Type: Bug',
        'Priority: High',
        'Area: Editor',
        'Reported by: ada@example.com',
        'Page: https://app.example.com/page/1',
        'Browser: UA',
      ].join('\n'),
    );
  });
});

describe('sortQueue', () => {
  it('puts blocking first, then oldest first within a priority', () => {
    const r = (id: string, priority: Report['priority'], createdAt: string): Report => ({ ...report, id, priority, createdAt });
    const sorted = sortQueue([
      r('a', 'low', '2026-10-01T09:00:00Z'),
      r('b', 'high', '2026-10-01T11:00:00Z'),
      r('c', 'blocking', '2026-10-01T12:00:00Z'),
      r('d', 'high', '2026-10-01T10:00:00Z'),
    ]);
    expect(sorted.map((x) => x.id)).toEqual(['c', 'd', 'b', 'a']);
  });
});

describe('toAgentPrompt', () => {
  it('gives a coding agent the report, where it happened and the app snapshot', () => {
    const p = toAgentPrompt(report, config);
    expect(p).toContain('# Bug [High] Editor: Enter at the end of a heading loses the heading');
    expect(p).toContain('Report id: r1');
    expect(p).toContain('Page: https://app.example.com/page/1');
    expect(p).toContain('"lastAction": "split-block"');
    expect(p).toContain('https://cdn.example.com/1.png');
    expect(p).toContain('Reproduce it, write a failing test, fix it');
  });
  it('asks for a plan instead of a fix on feature requests', () => {
    expect(toAgentPrompt({ ...report, type: 'feature' }, config)).toContain('Propose the smallest change');
  });
});
