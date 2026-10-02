// The popup: what you say, plus a screenshot of the tab, the element you picked and the page
// details, sent to a shipcue endpoint (shipcue report 879ec99b).
const { readPage, buildForm } = globalThis.shipcueLib;
const DEFAULT_ENDPOINT = 'https://shipcue.ibuildathing.com/api/shipcue';
const DEFAULT_CUELOG = 'https://shipcue.ibuildathing.com/cuelog/';
const HEADING = {
  bug: ['Report a bug', 'Say what you did and what happened.', 'I pressed Enter at the end of a heading and the heading disappeared.'],
  feature: ['Request a feature', 'Say what you want and why it helps.', 'It would help to nest pages under other pages.'],
  task: ['New agent task', 'Delegate a task to your agent.', 'Add a CSV export to the reports page, with the same columns as the table.'],
};

const $ = (id) => document.getElementById(id);
const state = { type: 'bug', tab: null, page: null, shot: null, element: null, location: null };

async function settings() {
  const s = await chrome.storage.sync.get(['endpoint', 'cuelog']);
  const endpoint = (s.endpoint || DEFAULT_ENDPOINT).replace(/\/$/, '');
  return { endpoint, cuelog: s.cuelog || (endpoint === DEFAULT_ENDPOINT ? DEFAULT_CUELOG : '') };
}

function show(id) {
  for (const v of ['report', 'done', 'settings']) $(v).hidden = v !== id;
}

function setType(type) {
  state.type = type;
  for (const b of document.querySelectorAll('[data-type]')) b.setAttribute('aria-checked', String(b.dataset.type === type));
  const [h, sub, ph] = HEADING[type];
  $('heading').textContent = h;
  $('subheading').textContent = sub;
  $('description').placeholder = ph;
}

function showError(id, msg) {
  $(id).textContent = msg;
  $(id).hidden = !msg;
}

/** The visible tab as a JPEG, scaled to at most 1600 px wide so it fits one request. */
async function captureTab(windowId) {
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 85 });
  const img = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const scale = Math.min(1, 1600 / img.width);
  const canvas = new OffscreenCanvas(Math.round(img.width * scale), Math.round(img.height * scale));
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
}

function showElement() {
  $('picked').hidden = !state.element;
  if (state.element) $('picked-text').textContent = state.element.selector || state.element.tag;
}

async function init() {
  // popup.html?tab=<id> points the popup at one tab (for automated tests, which cannot click the icon).
  const forced = Number(new URLSearchParams(location.search).get('tab'));
  const [tab] = forced ? [await chrome.tabs.get(forced)] : await chrome.tabs.query({ active: true, currentWindow: true });
  state.tab = tab;
  const { cuelog } = await settings();
  $('cuelog').hidden = !cuelog;
  if (cuelog) $('cuelog').href = cuelog;

  const restricted = !tab?.url || /^(chrome|edge|about|chrome-extension|devtools):/.test(tab.url) || tab.url.startsWith('https://chromewebstore.google.com');
  if (restricted) {
    showError('error', 'Chrome does not let extensions read this page. You can still send a report; it will come without a screenshot or page details.');
    $('pick').disabled = true;
    $('with-shot').checked = false;
    $('with-shot').disabled = true;
    state.page = { url: tab?.url || '', title: tab?.title || '', selection: '', userAgent: navigator.userAgent, viewport: null, scroll: null };
  } else {
    try {
      const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['lib.js'] }).then(() =>
        chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => globalThis.shipcueLib.readPage() }),
      );
      state.page = result;
    } catch {
      state.page = { url: tab.url, title: tab.title, selection: '', userAgent: navigator.userAgent, viewport: null, scroll: null };
    }
    if (state.page.selection) {
      $('selection-hint').textContent = `The text you selected comes along as context (${state.page.selection.length} characters).`;
      $('selection-hint').hidden = false;
    }
    try {
      state.shot = await captureTab(tab.windowId);
      $('shot').src = URL.createObjectURL(state.shot);
      $('shot').hidden = false;
    } catch {
      $('with-shot').checked = false;
    }
  }
  const key = `picked:${tab?.id}`;
  state.element = (await chrome.storage.session.get(key))[key] || null;
  showElement();
  const draft = (await chrome.storage.session.get(`draft:${tab?.id}`))[`draft:${tab?.id}`];
  if (draft) {
    setType(draft.type);
    $('description').value = draft.description;
    $('priority').value = draft.priority;
  }
  $('description').focus();
}

// Keep what was typed while the popup is closed to pick an element.
function saveDraft() {
  if (!state.tab) return;
  chrome.storage.session.set({ [`draft:${state.tab.id}`]: { type: state.type, description: $('description').value, priority: $('priority').value } });
}

async function pick() {
  saveDraft();
  await chrome.scripting.executeScript({ target: { tabId: state.tab.id }, files: ['lib.js', 'picker.js'] });
  window.close();
}

async function askLocation() {
  if (!$('with-location').checked) {
    state.location = null;
    return;
  }
  const ok = await chrome.permissions.request({ permissions: ['geolocation'] }).catch(() => false);
  if (!ok) {
    $('with-location').checked = false;
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (p) => {
      state.location = { latitude: +p.coords.latitude.toFixed(4), longitude: +p.coords.longitude.toFixed(4), accuracyMeters: Math.round(p.coords.accuracy) };
    },
    () => {
      $('with-location').checked = false;
      showError('error', 'Could not get your location.');
    },
    { timeout: 8000 },
  );
}

async function send() {
  const description = $('description').value.trim();
  if (!description) {
    showError('error', 'Say what happened first.');
    return;
  }
  showError('error', '');
  $('send').disabled = true;
  $('send').firstChild.textContent = 'Sending… ';
  try {
    const { endpoint, cuelog } = await settings();
    const form = buildForm({
      type: state.type,
      priority: $('priority').value,
      description,
      page: state.page,
      element: state.element,
      includeElement: !!state.element,
      location: $('with-location').checked ? state.location : null,
      screenshot: $('with-shot').checked ? state.shot : null,
    });
    const res = await fetch(`${endpoint}/reports`, { method: 'POST', body: form, credentials: 'include' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.id) {
      throw new Error(
        res.status === 413 ? 'The screenshot is too big for this app. Untick it and send again.' : body.error || `The app answered ${res.status}.`,
      );
    }
    await chrome.storage.session.remove([`picked:${state.tab.id}`, `draft:${state.tab.id}`]);
    $('done-link').hidden = !cuelog;
    if (cuelog) $('done-link').href = cuelog;
    show('done');
    setTimeout(() => window.close(), 4000);
  } catch (err) {
    const msg = err instanceof TypeError ? 'Could not reach the app. Check the address in Settings.' : err.message;
    showError('error', msg);
  } finally {
    $('send').disabled = false;
    $('send').firstChild.textContent = 'Send ';
  }
}

async function openSettings() {
  const s = await chrome.storage.sync.get(['endpoint', 'cuelog']);
  $('endpoint').value = s.endpoint || DEFAULT_ENDPOINT;
  $('cuelog-url').value = s.cuelog || '';
  showError('settings-error', '');
  show('settings');
}

async function saveSettings() {
  const raw = $('endpoint').value.trim().replace(/\/$/, '');
  let url;
  try {
    url = new URL(raw);
  } catch {
    showError('settings-error', 'That is not a web address.');
    return;
  }
  if (url.protocol !== 'https:' && url.hostname !== 'localhost') {
    showError('settings-error', 'Use an https address (or localhost while developing).');
    return;
  }
  // Sending to another app needs Chrome's permission for that site, asked once here.
  const granted = await chrome.permissions.request({ origins: [`${url.origin}/*`] }).catch(() => false);
  if (!granted) {
    showError('settings-error', 'shipcue needs permission to send reports to that site.');
    return;
  }
  const caps = await fetch(`${raw}/capabilities`).catch(() => null);
  if (caps && caps.status === 404) {
    showError('settings-error', 'Saved, but no shipcue handler answered there. Check the address ends where createShipcueHandler is mounted.');
  }
  await chrome.storage.sync.set({ endpoint: raw, cuelog: $('cuelog-url').value.trim() });
  if (!caps || caps.status !== 404) {
    show('report');
    void init();
  }
}

for (const b of document.querySelectorAll('[data-type]')) b.addEventListener('click', () => setType(b.dataset.type));
$('pick').addEventListener('click', () => void pick());
$('unpick').addEventListener('click', async () => {
  state.element = null;
  await chrome.storage.session.remove(`picked:${state.tab.id}`);
  showElement();
});
$('with-location').addEventListener('change', () => void askLocation());
$('send').addEventListener('click', () => void send());
$('description').addEventListener('input', saveDraft);
$('priority').addEventListener('change', saveDraft);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !$('report').hidden) {
    e.preventDefault();
    void send();
  }
});
$('open-settings').addEventListener('click', () => void openSettings());
$('close-settings').addEventListener('click', () => show('report'));
$('save').addEventListener('click', () => void saveSettings());
$('reset').addEventListener('click', () => {
  $('endpoint').value = DEFAULT_ENDPOINT;
  $('cuelog-url').value = '';
});

void init();
