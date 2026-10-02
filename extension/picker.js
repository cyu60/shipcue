// Click any element to add it to the report: an outline follows the pointer, Esc cancels.
// Injected with lib.js by the popup's "Pick an element".
(() => {
  if (globalThis.__shipcuePicking) return;
  globalThis.__shipcuePicking = true;

  const box = document.createElement('div');
  box.style.cssText =
    'position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #FFD43B;background:rgba(255,212,59,0.12);border-radius:3px;transition:all 40ms;';
  const tip = document.createElement('div');
  tip.style.cssText =
    'position:fixed;z-index:2147483647;left:50%;top:12px;transform:translateX(-50%);padding:6px 12px;border-radius:999px;background:#16203A;color:#fff;font:500 12px system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.25);';
  tip.textContent = 'shipcue: click an element to add it to your report · Esc to cancel';
  document.documentElement.append(box, tip);

  let current = null;
  const onMove = (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === box || el === tip) return;
    current = el;
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { left: `${r.left - 2}px`, top: `${r.top - 2}px`, width: `${r.width + 4}px`, height: `${r.height + 4}px` });
  };
  const done = () => {
    removeEventListener('mousemove', onMove, true);
    removeEventListener('click', onClick, true);
    removeEventListener('keydown', onKey, true);
    box.remove();
    globalThis.__shipcuePicking = false;
  };
  const onClick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!current) return;
    const element = globalThis.shipcueLib.describeElement(current);
    done();
    chrome.runtime.sendMessage({ type: 'shipcue:picked', element });
    tip.textContent = 'Added. Click the shipcue icon to finish the report.';
    setTimeout(() => tip.remove(), 3500);
  };
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    done();
    tip.remove();
  };
  addEventListener('mousemove', onMove, true);
  addEventListener('click', onClick, true);
  addEventListener('keydown', onKey, true);
})();
