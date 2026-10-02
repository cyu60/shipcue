// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from 'vitest';

type Lib = {
  cssPath(el: Element): string;
  describeElement(el: Element): { selector: string; tag: string; text: string; html: string; rect: { width: number } };
  buildContext(o: { selection?: string; element?: unknown }): string;
  buildDiagnostics(o: Record<string, unknown>): Record<string, unknown>;
  buildForm(o: Record<string, unknown>): FormData;
};
let lib: Lib;
beforeAll(async () => {
  // @ts-expect-error a plain browser script, no types
  await import('../extension/lib.js');
  lib = (globalThis as unknown as { shipcueLib: Lib }).shipcueLib;
});

const page = { url: 'https://app.example.com/settings', title: 'Settings', selection: 'Save failed', description: null, language: 'en', viewport: { width: 1280, height: 800, devicePixelRatio: 2 }, scroll: { x: 0, y: 120 }, referrer: null, userAgent: 'UA' };

describe('the shipcue extension (report 879ec99b)', () => {
  it('finds a selector for the picked element: its id, or a short path', () => {
    document.body.innerHTML = '<main><form id="profile"><button class="btn primary">Save</button><button class="btn">Cancel</button></form><ul><li>a</li><li>b</li></ul></main>';
    expect(lib.cssPath(document.querySelector('#profile')!)).toBe('#profile');
    expect(lib.cssPath(document.querySelector('.primary')!)).toBe('#profile > button.btn.primary:nth-of-type(1)');
    expect(lib.cssPath(document.querySelectorAll('li')[1]!)).toBe('body > main > ul > li:nth-of-type(2)');
  });

  it('keeps the element HTML, cut short when it is huge', () => {
    document.body.innerHTML = `<div id="big">${'<p>row</p>'.repeat(2000)}</div>`;
    const el = lib.describeElement(document.getElementById('big')!);
    expect(el.tag).toBe('div');
    expect(el.html.length).toBeLessThan(6200);
    expect(el.html).toMatch(/more characters -->$/);
  });

  it('puts the selection and the element in the context, and where/when/what in the snapshot', () => {
    const element = { selector: '#save', tag: 'button', text: 'Save', html: '<button id="save">Save</button>', rect: { x: 10, y: 20, width: 80, height: 32 } };
    const ctx = lib.buildContext({ selection: page.selection, element });
    expect(ctx).toContain('Save failed');
    expect(ctx).toContain('Element: #save (button, 80×32 at 10,20)');
    expect(ctx).toContain('<button id="save">Save</button>');
    const d = lib.buildDiagnostics({ page, element, location: { latitude: 37.4275, longitude: -122.1697, accuracyMeters: 30 }, now: new Date('2026-10-02T18:40:00Z') });
    expect(d).toMatchObject({ source: 'shipcue-extension', time: '2026-10-02T18:40:00.000Z', title: 'Settings', viewport: { width: 1280 }, element: { selector: '#save' }, location: { latitude: 37.4275 } });
    expect(typeof d.timezone).toBe('string');
  });

  it("builds the form shipcue's handler takes", () => {
    const shot = new Blob(['jpeg'], { type: 'image/jpeg' });
    const form = lib.buildForm({ type: 'bug', priority: 'high', description: 'Save does nothing', page, element: null, includeElement: false, location: null, screenshot: shot });
    expect(form.get('type')).toBe('bug');
    expect(form.get('area')).toBe('other');
    expect(form.get('pageUrl')).toBe(page.url);
    expect(form.get('context')).toBe('Save failed');
    expect((form.get('screenshot') as File).name).toBe('page.jpg');
    expect(JSON.parse(form.get('diagnostics') as string)).not.toHaveProperty('location');
  });
});
