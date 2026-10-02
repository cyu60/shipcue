// Shared by the popup and the element picker (shipcue report 879ec99b). Plain script: it
// sets globalThis.shipcueLib so it loads both as a <script> and through executeScript.
(function (g) {
  const MAX_HTML = 6000;
  const MAX_TEXT = 300;

  /** A CSS selector that finds this element again: an id if it has one, else a short path. */
  function cssPath(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return `#${el.id}`;
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) {
        parts.unshift(`#${node.id}`);
        break;
      }
      let part = node.tagName.toLowerCase();
      const cls = [...node.classList].filter((c) => /^[A-Za-z][\w-]*$/.test(c)).slice(0, 2);
      if (cls.length) part += `.${cls.join('.')}`;
      const parent = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === node.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      if (node.tagName === 'BODY') break;
      node = parent;
    }
    return parts.join(' > ');
  }

  /** What the picker keeps about the clicked element. */
  function describeElement(el) {
    const r = el.getBoundingClientRect();
    const html = el.outerHTML || '';
    return {
      selector: cssPath(el),
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, MAX_TEXT),
      html: html.length > MAX_HTML ? `${html.slice(0, MAX_HTML)}\n<!-- …${html.length - MAX_HTML} more characters -->` : html,
      rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
    };
  }

  /** The page as the popup sees it, read inside the tab. */
  function readPage() {
    const meta = (name) => document.querySelector(`meta[name="${name}"], meta[property="${name}"]`)?.getAttribute('content') || null;
    return {
      url: location.href,
      title: document.title,
      selection: String(getSelection() || '').trim().slice(0, 4000),
      description: meta('description') || meta('og:description'),
      language: document.documentElement.lang || navigator.language,
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio: devicePixelRatio },
      scroll: { x: Math.round(scrollX), y: Math.round(scrollY) },
      referrer: document.referrer || null,
      userAgent: navigator.userAgent,
    };
  }

  /** The Context box: the selected text, then the picked element (selector, text, HTML). */
  function buildContext({ selection, element }) {
    const out = [];
    if (selection) out.push(selection);
    if (element) {
      out.push(
        [
          `Element: ${element.selector} (${element.tag}, ${element.rect.width}×${element.rect.height} at ${element.rect.x},${element.rect.y})`,
          element.text ? `Text: ${element.text}` : '',
          'HTML:',
          element.html,
        ]
          .filter(Boolean)
          .join('\n'),
      );
    }
    return out.join('\n\n');
  }

  /** What the app snapshot holds: where, when, which browser, and where you are if you said so. */
  function buildDiagnostics({ page, element, location, now = new Date() }) {
    return {
      source: 'shipcue-extension',
      time: now.toISOString(),
      localTime: now.toString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      title: page.title,
      description: page.description,
      language: page.language,
      viewport: page.viewport,
      scroll: page.scroll,
      referrer: page.referrer,
      ...(element ? { element: { selector: element.selector, tag: element.tag, rect: element.rect } } : {}),
      ...(location ? { location } : {}),
    };
  }

  /** The multipart form shipcue's handler takes at POST {endpoint}/reports. */
  function buildForm({ type, priority, description, page, element, location, includeElement, screenshot, now }) {
    const form = new FormData();
    form.set('type', type);
    form.set('priority', priority);
    form.set('area', 'other');
    form.set('description', description);
    form.set('pageUrl', page.url);
    form.set('userAgent', page.userAgent);
    form.set('context', buildContext({ selection: page.selection, element: includeElement ? element : null }));
    form.set('diagnostics', JSON.stringify(buildDiagnostics({ page, element: includeElement ? element : null, location, now })));
    if (screenshot) form.append('screenshot', screenshot, 'page.jpg');
    return form;
  }

  g.shipcueLib = { cssPath, describeElement, readPage, buildContext, buildDiagnostics, buildForm };
})(globalThis);
