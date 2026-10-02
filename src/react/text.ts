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
  preview: string;
  raw: string;
  remove: string;
  addScreenshot: string;
  addScreenshotOrFile: string;
  /** {what} is "screenshots", "screenshots, files" and/or " or a video"; {max} the count. */
  attachHint: string;
  recordScreen: string;
  attachVideo: string;
  page: string;
  dontAttach: string;
  pastReports: string;
  shortcuts: string;
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
  preview: 'Preview',
  raw: 'Raw',
  remove: 'remove',
  addScreenshot: 'Add a screenshot',
  addScreenshotOrFile: 'Add a screenshot or file',
  attachHint: 'Paste or drop {what} into the text box, or add up to {max}.',
  recordScreen: 'Record screen',
  attachVideo: 'or attach a video',
  page: 'Page:',
  dontAttach: "don't attach",
  pastReports: 'Past reports',
  shortcuts: 'Shortcuts',
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
