// Every word the panel and the board show, so each app can say things its own way
// (text={{ seeReports: 'See your reports' }}). The defaults are shipcue's own wording.

export interface ShipcueText {
  // Tabs, the panel heading and the text box, per report type.
  bugTab: string;
  featureTab: string;
  taskTab: string;
  bugTitle: string;
  bugSubtitle: string;
  bugPlaceholder: string;
  featureTitle: string;
  featureSubtitle: string;
  featurePlaceholder: string;
  taskTitle: string;
  taskSubtitle: string;
  taskPlaceholder: string;
  // The form.
  priority: string;
  where: string;
  context: string;
  addContext: string;
  dictate: string;
  listening: string;
  micBlocked: string;
  preview: string;
  raw: string;
  remove: string;
  addScreenshot: string;
  addScreenshotOrFile: string;
  /** {what} is "screenshots", "screenshots, files" and/or " or a video"; {max} the count. */
  attachHint: string;
  recordScreen: string;
  attachVideo: string;
  // Select an area and mark it up (shipcue report 58b727d9).
  selectArea: string;
  selectAreaHint: string;
  captureDeclined: string;
  captureUnsupported: string;
  captureFailed: string;
  editScreenshot: string;
  annotateTitle: string;
  toolPen: string;
  toolArrow: string;
  toolRect: string;
  toolHighlight: string;
  toolText: string;
  toolBlur: string;
  toolCrop: string;
  undo: string;
  redo: string;
  clear: string;
  color: string;
  strokeWidth: string;
  altText: string;
  altPlaceholder: string;
  altHint: string;
  addToReport: string;
  cancel: string;
  page: string;
  dontAttach: string;
  pastReports: string;
  shortcuts: string;
  display: string;
  yours: string;
  yourReports: string;
  noReportsYet: string;
  starsHint: string;
  starred: string;
  pin: string;
  pinned: string;
  pinIt: string;
  unpinIt: string;
  pinHint: string;
  dragPanel: string;
  seeTheFix: string;
  signIn: string;
  sendAnonymously: string;
  buttonSize: string;
  textSize: string;
  resetPosition: string;
  sizeNames: [string, string, string];
  send: string;
  sending: string;
  // After sending.
  sent: string;
  seeReports: string;
  videoNotAttached: string;
  // The floating button.
  openButton: string;
  closeButton: string;
  stopRecording: string;
  // The board.
  open: string;
  fixed: string;
  all: string;
  changelog: string;
  nothingWaiting: string;
  nothingFixed: string;
  nothingShipped: string;
  latestFirst: string;
  askedFor: string;
  done: string;
  inProgress: string;
  inReview: string;
  pills: string;
  tabs: string;
  cards: string;
  list: string;
  loading: string;
  queueTitle: string;
  /** {n} is how many are open. */
  queueSummary: string;
  doneBelow: string;
}

export const DEFAULT_TEXT: ShipcueText = {
  bugTab: 'Bug',
  featureTab: 'Feature request',
  taskTab: 'Agent task',
  bugTitle: 'Report a bug',
  bugSubtitle: 'Say what you did and what happened.',
  bugPlaceholder: 'I pressed Enter at the end of a heading and the heading disappeared.',
  featureTitle: 'Request a feature',
  featureSubtitle: 'Say what you want and why it helps.',
  featurePlaceholder: 'It would help to nest pages under other pages.',
  taskTitle: 'New agent task',
  taskSubtitle: 'Delegate a task to your agent.',
  taskPlaceholder: 'Add a CSV export to the reports page, with the same columns as the table.',
  priority: 'Priority',
  where: 'Where',
  context: 'Context',
  addContext: '+ Add context',
  dictate: 'Dictate',
  listening: 'Listening… click to stop',
  micBlocked: 'The microphone is blocked for this page. Allow it in the address bar, then try again.',
  preview: 'Preview',
  raw: 'Raw',
  remove: 'remove',
  addScreenshot: 'Add a screenshot',
  addScreenshotOrFile: 'Add a screenshot or file',
  attachHint: 'Paste or drop {what} into the text box, or add up to {max}.',
  recordScreen: 'Record screen',
  attachVideo: 'or attach a video',
  selectArea: 'Select area',
  selectAreaHint: 'Drag to select an area · Enter captures · Esc cancels',
  captureDeclined: 'Screen capture was not allowed. Paste a screenshot instead.',
  captureUnsupported: 'This browser cannot capture the page. Paste a screenshot instead.',
  captureFailed: 'Could not capture that area. Paste a screenshot instead.',
  editScreenshot: 'Edit',
  annotateTitle: 'Mark up the screenshot',
  toolPen: 'Draw',
  toolArrow: 'Arrow',
  toolRect: 'Box',
  toolHighlight: 'Highlight',
  toolText: 'Text',
  toolBlur: 'Blur',
  toolCrop: 'Crop',
  undo: 'Undo',
  redo: 'Redo',
  clear: 'Clear',
  color: 'Colour',
  strokeWidth: 'Line width',
  altText: 'Alt text',
  altPlaceholder: 'What it shows, for screen readers and agents',
  altHint: 'Saved with the image.',
  addToReport: 'Add to report',
  cancel: 'Cancel',
  page: 'Page:',
  dontAttach: "don't attach",
  pastReports: 'Past reports',
  shortcuts: 'Shortcuts',
  display: 'Display',
  yours: 'Yours',
  yourReports: 'Your reports',
  noReportsYet: 'Reports you send from this browser show up here.',
  starsHint: 'Pin one to keep it at the top, here and on the CueLog. Kept in this browser.',
  starred: 'Pinned',
  pin: 'Pin',
  pinned: 'Pinned',
  pinIt: 'Pin this report',
  unpinIt: 'Unpin this report',
  pinHint: 'Pin it: once sent, it stays at the top of Yours and the CueLog',
  dragPanel: 'Drag to move',
  seeTheFix: 'See the fix on GitHub',
  signIn: 'Sign in',
  sendAnonymously: 'Send anonymously (leave my name off it)',
  buttonSize: 'Button size',
  textSize: 'Text size',
  resetPosition: 'Reset position',
  sizeNames: ['S', 'M', 'L'],
  send: 'Send',
  sending: 'Sending…',
  sent: 'Thanks. It is in the queue.',
  seeReports: 'See your CueLog',
  videoNotAttached: 'The video was not attached:',
  openButton: 'Report a bug or request a feature',
  closeButton: 'Close report',
  stopRecording: 'Stop recording',
  open: 'Open',
  fixed: 'Fixed',
  all: 'All',
  changelog: 'Changelog',
  nothingWaiting: 'Nothing waiting.',
  nothingFixed: 'Nothing fixed yet.',
  nothingShipped: 'Nothing shipped yet.',
  latestFirst: 'What was fixed, latest first.',
  askedFor: 'Asked for:',
  done: 'Done',
  inProgress: 'In progress',
  inReview: 'In review',
  pills: 'Pills',
  tabs: 'Tabs',
  cards: 'Cards',
  list: 'List',
  loading: 'Loading…',
  queueTitle: 'Queue',
  queueSummary: '{n} open, most urgent first.',
  doneBelow: 'Done ones stay below, greyed out.',
};

/** The defaults with an app's own words on top; empty strings are ignored. */
export function resolveText(...layers: (Partial<ShipcueText> | undefined)[]): ShipcueText {
  const out = { ...DEFAULT_TEXT };
  for (const layer of layers) {
    for (const [k, v] of Object.entries(layer ?? {})) {
      if (typeof v === 'string' && v !== '') (out as unknown as Record<string, string>)[k] = v;
    }
  }
  return out;
}

/** "Paste or drop {what}…" filled in. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]) : m));
}
