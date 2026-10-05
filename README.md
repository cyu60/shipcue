<div align="center">

<a href="https://shipcue.ibuildathing.com"><img src="docs/banner.png" alt="shipcue: bug reports your coding agents can fix" width="100%"></a>

<br>

<a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-16203A?style=flat-square" alt="MIT license"></a> <img src="https://img.shields.io/badge/tests-590%20passing-2E5BFF?style=flat-square" alt="590 tests passing"> <img src="https://img.shields.io/badge/MCP-ready-FFD43B?style=flat-square&labelColor=16203A" alt="MCP ready"> <img src="https://img.shields.io/badge/Postgres-self--hosted-16203A?style=flat-square" alt="Self-hosted on Postgres">

# shipcue: Bug Reports Your Coding Agents Can Fix

**Drop-in report button** &nbsp;•&nbsp; **Queue in your own Postgres** &nbsp;•&nbsp; **Agents claim over MCP** &nbsp;•&nbsp; **One report, one agent**

🌐 [Website](https://shipcue.ibuildathing.com) &nbsp;•&nbsp; ☁️ [Cloud](https://shipcue.ibuildathing.com/cloud/) &nbsp;•&nbsp; 📖 [Docs](https://shipcue.ibuildathing.com/docs/) &nbsp;•&nbsp; 📝 [Blog](https://shipcue.ibuildathing.com/blog/) &nbsp;•&nbsp; ✉️ [Contact](https://shipcue.ibuildathing.com/contact/)

</div>

---

A drop-in bug report and feature request button whose inbox is a queue that people **and coding agents** both work from.

<p align="center"><img src="docs/report-button.png" alt="The shipcue panel: Bug, Feature request and Agent task tabs, priority, where, paste or drop screenshots, files or a video, screen recording, Past reports &amp; changelog and Shortcuts links, Send with ⌘↵, and a Powered by shipcue line" width="420"></p>

Someone in your app clicks the button, says what broke or what they want, pastes a screenshot, and sends. shipcue files it with the page address, browser and a snapshot of app state you choose. Then Claude Code, Codex or a teammate claims the most urgent report, gets a ready-made task prompt, fixes it, and closes it with the PR link.

```
user files a report  →  queue (your Postgres)  →  agent claims the top one  →  PR  →  closed as fixed
```

- **Self-hosted.** One table in your own Postgres. No third-party dashboard, no per-seat pricing.
- **Agent-ready.** Every report carries enough context to act on, and an MCP server lets agents pull from the queue without two of them ever taking the same report.
- **No CSS setup.** The button uses inline styles and takes an accent colour.

It started as the report button inside three apps (a founders dashboard, a hackathon platform and a block outliner) and was pulled out once the same five parts kept showing up: a button, a form, automatic context, storage, and somewhere for reports to go.

## Use cases

- **Hackathon teams running many agents.** Everyone reports into one queue and each agent claims one report at a time, so two agents never fix the same bug and nobody's fix undoes someone else's.
- **Founders with early users.** Users report from the page where it broke, with context attached. Your agent works the queue, most urgent first, and you review the PRs.
- **Internal tools and dashboards.** An inline button in the header, sign-in required, new reports posted to Slack or email, and the data stays in your database.
- **Beta tests and dogfooding sessions.** Testers file what they hit; areas and priority keep the pile in order for the agents.
- **Feature requests too.** An agent can draft one as a PR, or you close it as won't fix with a reason.

More on the [use cases page](https://shipcue.ibuildathing.com/use-cases/).

## Install

```bash
npm i shipcue   # or pnpm add shipcue
```

Until it's on npm, install the prebuilt release (nothing builds on install, so it works with pnpm on Vercel; pick the newest from [releases](https://github.com/cyu60/shipcue/releases)):

```bash
pnpm add https://github.com/cyu60/shipcue/releases/download/v<version>/shipcue-<version>.tgz
```

Then run `npx shipcue doctor` in your app's repo; it says what is missing and how to fix it (see [Check your setup](#check-your-setup)). On shipcue Cloud, with no database of your own: `npx shipcue init --cloud <pk_…>`.

## 1. Create the table

Run [`sql/schema.sql`](sql/schema.sql) on your database (Supabase, InsForge, Neon, RDS or local Postgres). Upgrading from 0.1: run it again; it adds the `video` column to the existing table.

## 2. Mount the handler

Next.js App Router, `app/api/shipcue/[...path]/route.ts`:

```ts
import { Pool } from 'pg';
import { createShipcueHandler, postgresStore } from 'shipcue/server';
import { resolveConfig } from 'shipcue';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const handler = createShipcueHandler({
  store: postgresStore(pool),
  config: resolveConfig({ areas: [{ value: 'editor', label: 'Editor' }, { value: 'billing', label: 'Billing' }] }),
  getReporter: async (req) => (await getSession(req))?.email ?? null, // your auth
  requireReporter: true,
  agentToken: process.env.SHIPCUE_TOKEN, // leave unset to switch the agent API off
  onReport: async (report) => {
    // email the team, post to Slack, mirror to your task board...
  },
});

export { handler as GET, handler as POST };
```

The handler is a plain `(Request) => Promise<Response>`, so it also works in Hono, Remix, Bun, Deno and Cloudflare Workers. Screenshots are stored as data URLs unless you pass `saveScreenshot(file, key)` to upload them to S3, Supabase Storage or similar.

**Retry-safe filing.** The panel sends an `idempotencyKey` form field with each report: one per draft, the same on every retry of it (a failed send, a timeout), new after a successful send or for a new report. A repeat key gets the report already filed (same id, status 200, `replayed: true`) instead of a copy, and `onReport` and broadcasters hear about it once. Both built-in stores do this; `postgresStore` needs the "Upgrading from 0.26" block of `sql/schema.sql` (a nullable `idempotency_key` column and a unique index per project), and without it reports file as before, without the protection. Custom stores get `NewReport.idempotencyKey` and return the first report with `replayed: true` on a repeat. Keys that are too long (over 100 characters) or have odd characters are ignored, never refused.

**Your reports on any device.** When `getReporter` reads a verified session, add `reporterPortal: true`: `GET /mine` returns the signed-in reporter's own reports (status, fix line, PR; never anyone else's, never diagnostics) and the panel's Yours list adds them. Not for a reporter the browser says itself (the button's `reporter` prop), so shipcue Cloud projects skip it.

**Open what you sent.** The panel keeps each report sent from this browser in full (`shipcue:mine` in localStorage: the text, type, priority, area, page, picked-out context, how many screenshots and files, whether a video went with it, alt texts, when it was sent; never the screenshot or video data). Each item in Yours opens a read-only view of it, with the server's status, fix line and PR merged in when the handler offers `GET /mine`; Back returns to the list. It works with a custom `submit` too. Kept to the latest 50 (`MAX_MINE`), text cut at 4,000 characters, the list held under about 200 KB (the oldest go first). For a page with only a custom `submit`, or offline, `<LocalReports />` from `shipcue/react` shows the same list and detail from this browser's storage alone (props: `text`, `renderContext`, `style`).

**Videos.** Pass `saveVideo(file, key)` to turn on `POST /reports/:id/video`: whoever filed a report can attach one screen recording or video (WebM, MP4 or MOV, up to 40 MB) within 30 minutes. Hosts that cap request bodies (Vercel: 4.5 MB) should upload from the browser instead, with the button's `uploadVideo` prop and a presigned URL.

## 3. Add the button

```tsx
import { ReportButton } from 'shipcue/react';

<ReportButton
  areas={[{ value: 'editor', label: 'Editor' }, { value: 'billing', label: 'Billing' }]}
  accentColor="#8c1515"
  diagnostics={() => ({ route: location.pathname, openDoc: store.docId, lastAction: store.lastAction })}
/>
```

Use `variant="inline"` for a header or toolbar button on phones, where a floating bubble covers the controls. Pass `submit={(form) => myServerAction(form)}` to send through a server action instead of `fetch`; the form carries `idempotencyKey` (one per draft, the same on a retry), so file a key once and answer a repeat with the report already filed. Pass `reporter={user.email}` to say who is signed in on your site: it goes with each report in the `x-shipcue-user` header, shipcue Cloud shows it as the reporter, and your own handler can read it in `getReporter`.

What else the panel does:

- **Record screen or attach a video.** Recordings stop at 60 seconds. The video uploads after the report is filed; if it fails, the report is still filed and the panel says so. Pass `uploadVideo={(reportId, blob) => …}` to upload it yourself; otherwise it goes to the handler. With `submit` and no `uploadVideo`, video is hidden.
- **Recent errors.** Page errors, unhandled rejections and `console.error` calls from before the report are added to the snapshot as `recentErrors`. Turn off with `captureErrors={false}`.
- **The page.** The panel shows which page it will attach, with a "don't attach" link.
- **Move it.** People can drag the floating button anywhere, by the button or by the panel's title; the two move together, the panel stays on screen (it opens above or below the button, whichever has room, settled when you let go), and the spot is kept in their browser. Reset position (⌃⇧H / Alt+Shift+H, or Display) puts it back; `movable={false}` keeps it bottom-right.
- **Resize it.** Drag the small grip on the panel's free corner (the one away from the button) to make it wider and taller; the text box takes the extra height, so there is more room to write. It never gets smaller than the default or leaves the screen, works with every text size, and arrow keys resize it once the grip is focused (Shift for bigger steps). The size is kept in the browser; Reset position puts it back too. `resizable={false}` keeps the default size; the inline variant has no grip.
- **Copy prompt for my agent.** A small link in the panel's footer copies a prompt for Claude Code or Codex with the app, the page, the form's choices (type, priority, your areas), what the person typed, any picked-out context and the snapshot shipcue would attach. The agent asks for anything missing, then files it with the MCP tool `file_report` or a ready `curl` to your endpoint. Hidden when you send reports with `submit` and no `endpoint`.
- **Your own mark.** The button shows shipcue's hard hat; `icon="ship"` brings back the sailboat, and `launcherIcon={<YourLogo />}` draws your own logo.
- **Your own description editor.** `renderDescription={({ value, onChange, submit, textarea }) => …}` draws the description in place of the text box, e.g. your app's outline editor; `textarea` is shipcue's own box on the same text, for a "Raw text" switch.
- **Your own fields.** `formExtras={<label><input type="checkbox" /> Pin it</label>}` draws a small control under the text box in the Bug and Feature request forms, and `fields={() => ({ pinned: on ? '1' : '0' })}` adds them to the report when it is sent (never over shipcue's own fields). With `submit`, read them from the FormData; with an endpoint, they arrive as form fields.
- **Dictate.** A small mic beside the text box (and ⌃M / Alt+Shift+M) types what you say, using the browser's speech recognition; it is listed in Shortcuts and hidden in browsers without it.
- **Keys.** A small Keys button next to Dictate writes the shortcuts you press into the report as text, so you never spell out ⌘ + Enter by hand: click it (or focus it and press Enter), press a combination and it lands at the caret as `⌘ + Enter` or `⌃ + ⇧ + D` on a Mac and `Ctrl + Shift + D` elsewhere. Press as many as you like; Esc or a second click stops (Esc itself is written with a modifier, e.g. `⇧ + Esc`). While it listens, every key is text, shipcue's own hotkeys and ⌘↵ included. With `renderDescription` it adds to your editor's text through `onChange`, as Dictate does. Text keys `keys`, `keysRecording`, `keysHint`.
- **Capture comes with the panel.** When the floating panel opens, the page behind it is tinted: drag anywhere on the tint to select part of the page, adjust it and capture it, exactly as Select area does, with no hotkey or button (a small hint at the top says "Drag to capture part of the page · click to dismiss"). A plain click or tap on the tint, or Esc, lifts it so the page is usable again (copy text into the report) while the panel stays open; a second Esc closes the panel. The Select area tile and ⌃⇧A bring capture back. The panel and button stay above the tint, and typing in the panel never captures. `captureOnOpen` turns it on or off: on by default for the floating panel (also with `trigger={false}`), off for `variant="inline"` unless you set it; `captureOnOpen={false}` keeps the panel as it was. It is skipped where the browser cannot capture, on your own tabs, and once the report has all its screenshots.
- **Select area and mark it up.** The small Select area tile next to the screenshot tile (and ⌃⇧A / Alt+Shift+A, listed in Shortcuts) tints the page; drag a rectangle. Letting go does not capture: the selection stays, CleanShot-style, to adjust first. Drag inside it to move it, drag one of its eight handles (corners and edges) to resize it, or type a size into the small dark toolbar under it (width × height, from the top-left, kept inside the viewport); arrows move it (Alt: 1px), Shift+arrows resize it, and a new drag outside it starts over. The toolbar has **Capture** (Enter) to attach it as it is, **Capture & annotate** to mark it up first, and Cancel (Esc). The pixels come from the browser's own tab capture (`getDisplayMedia`), asked for only at Capture; the share is kept while the panel is open, so the browser asks once per session, not per capture, and it stops when the panel closes, the page is hidden, or after `captureKeepAlive` ms idle (two minutes by default; 0 stops it after each capture). If sharing was stopped from the browser, the next capture asks again. Where the browser cannot capture, the panel says so in one line. Capture & annotate opens an annotator: Draw, Arrow, Box, Highlight, Text, Blur (pixelates) and Crop, six colours, S/M/L lines, Undo/Redo (⌘Z / ⇧⌘Z), Clear, and **Alt text**. Add to report attaches it as a PNG within your screenshot limits; the pencil on any screenshot opens it in the annotator again. Alt text is sent as `screenshotAlt` (one per screenshot, in order), kept on the screenshot as `;alt=` / `#alt=` (cap: `resolveConfig({ maxAltText })`, 500 by default), and shown as the image's alt on the board, the CueLog and the preview. `dimOnOpen` (deprecated in favour of `captureOnOpen`) tints the page whenever the panel is open, without blocking it; with `captureOnOpen` on it shows only once the capture tint is lifted.
- **Your own words.** Pass `text={{ seeReports: 'See your reports', bugTab: 'Problem', send: 'Submit' }}` to the button or the board: anything you leave out keeps shipcue's wording (`DEFAULT_TEXT` from `shipcue/react` lists every key).
- **Limits.** Set them once where you create the handler, `config: resolveConfig({ areas, maxScreenshots: 20, maxTotalScreenshotBytes: 4 * 1024 * 1024 })`, and the button follows (it reads them from `{endpoint}/capabilities`). If you send reports yourself with `submit`, pass the same numbers as `limits={{ maxScreenshots: 20 }}`. Defaults: 10 screenshots, 5 MB each, 4 MB together (under Vercel's 4.5 MB request cap), 40 MB and 60 seconds of video.
- **Videos past 4.5 MB.** Hosts like Vercel cap a request at 4.5 MB, so for longer recordings upload the video from the browser straight to your storage with `uploadVideo`, then post its URL to `{endpoint}/reports/:id/video` as `{ url }`; the handler checks it with `acceptVideoUrl(url, id)`. shipcue's own site does this with Vercel Blob client uploads (`website/_src/button.mjs`, `website/_src/upload.mjs`).
- **Any file.** `resolveConfig({ allowFiles: true })` lets people attach PDFs, logs and other files next to screenshots, under the same limits (never HTML, SVG or scripts). Off by default: turn it on where whoever reads your reports can open any file. Files never show on the public board.
- **Past reports.** `pastReportsHref="/reports"` adds a Past reports link to the panel and a See your reports link after sending; `pastReportsLabel` changes its text.

The panel has three tabs: **Bug**, **Feature request** and **Agent task** (a direct instruction for an agent; limit them with `types={['bug', 'feature']}` on a public page). The panel ends with a small "Powered by shipcue · ★ Star it on GitHub" line. If shipcue helps you, a star really helps; `watermark={false}` turns it off.

### Keyboard shortcuts

| | Mac | Windows / Linux |
|---|---|---|
| Agent task | ⌘J | Alt+Shift+J |
| Bug | ⌃B | Alt+Shift+B |
| Feature request | ⌃F | Alt+Shift+F |
| Send | ⌘↵ | Ctrl+↵ |

Text highlighted on the page comes along in an editable, removable **Context** box (an outline opens as a Preview with bullets and `[[links]]`; Raw is the text; `renderContext` draws the Preview with your app's own renderer) (or pass `getContext` to supply your app's selected rows or blocks), and agents get it as its own section of the task prompt. Change the keys with `hotkeys={{ task: ['Mod+J'] }}` ("Mod" is ⌘ on a Mac, Ctrl elsewhere), turn them off with `hotkeys={false}`, or open the panel from your own menu with `openReport('task')`, and start Select area from a command palette with `selectArea()` (it fires the `shipcue:select-area` window event). People can also change their own keys from the panel's small Shortcuts link; their choice is kept in their browser and wins over yours. If your app's own keymap opens shipcue (`hotkeys={false}`), pass `onEditShortcuts={openYourKeymapEditor}` and the link opens that instead.

### Your own tabs

An app with its own flow (say an agent-task composer backed by its API) can draw it as a tab in the same panel: `extraTabs={[{ id: 'agent', label: 'Agent task', render: ({ text, context, close }) => <TaskComposer … /> }]}`. Give it a hotkey with `hotkeys={{ agent: ['Mod+J'] }}` or open it with `openReport('agent')`; `onOpenChange` and `closeReport()` let the app follow and close the panel. If the app already has a help button, `trigger={false}` hides shipcue's own and the app opens the panel with `openReport('bug')`.

## 4. Let agents work the queue

```bash
claude mcp add shipcue \
  -e SHIPCUE_URL=https://your.app/api/shipcue \
  -e SHIPCUE_TOKEN=... \
  -- npx shipcue-mcp
```

Tools: `file_report`, `list_reports`, `claim_next_report`, `get_report`, `claim_report`, `release_report`, `close_report`, `submit_for_review`, `heartbeat_report`, `add_note`, `merge_report`, `list_my_reports`, `set_report_scope`, `list_conflicts`.

**Filing for a person.** `file_report` files a bug, feature request or agent task with the same fields the panel sends (type, description, priority, area, page URL, context, diagnostics), as a multipart POST from the agent's machine to `{SHIPCUE_URL}/reports`, so your browser CORS rules do not get in the way (sign-in and anonymous limits still apply). It needs no token: `SHIPCUE_URL` alone is enough for it. The panel's **Copy prompt for my agent** link hands the agent everything it needs to call it.

**One token per agent.** Pass `agents: async (token) => ({ id, name, pull?, types?, leaseSeconds? }) | null` to the handler and each agent claims under its own name, can only release or close what it holds, and (with `pull: false`) only takes what someone assigned to it. `leaseSeconds` gives agent claims a lease: an agent that stops calling `heartbeat_report` loses the report back to the queue. `submit_for_review` puts the report in review with the PR link, with no lease, until it is closed.

`claim_next_report` hands back a prompt like this:

````md
# Bug [Blocking] Editor: Enter at the end of a heading deletes it

Enter at the end of a heading deletes it

## Where
Report id: a44f5541-…
Page: https://your.app/page/42
Filed: 2026-10-01T23:01:08Z by ada@example.com

## App snapshot
```json
{ "blocks": 7, "lastAction": "split-block" }
```

## What to do
Reproduce it, write a failing test, fix it, and close the report with the PR link.
````

Claims are atomic (`FOR UPDATE SKIP LOCKED`), so several agents can drain the queue at once.

**Work areas.** When several agents (or sessions) work one repo, a claim can say what it touches: `{ areas?, paths?, migration?, branch? }` as `scope` on `claim_report` / `claim_next_report` (or `POST reports/:id/claim { scope }`), changed later with `set_report_scope` (`POST reports/:id/scope`). `paths` are globs (`src/server/**`; a folder covers what is under it). Two active claims (claimed or in review) that share an area, a file, a migration slot or a branch get a warning in the claim's response, a small "overlaps #id8" badge in the CueLog, and a line in `list_conflicts` (`GET reports/conflicts`, or `team/conflicts` for members), which also says `free: true` when nothing is claimed or in review. It never blocks, and the scope lives in the report's history, so there is no schema change. Design and what comes next: [docs/swarm.md](docs/swarm.md).

## Check your setup

```bash
npx shipcue doctor                                         # files, env, lockfile
npx shipcue doctor --url https://your-app.com/api/shipcue  # plus the live endpoint, token and tables
```

One ✓ or ✗ line per check, with the exact fix under each ✗ (exit code 1 if any fail):

- shipcue is installed, and which version (and the newest release, unless `--offline`)
- no signed `release-assets.githubusercontent.com` URL in `pnpm-lock.yaml`, `package-lock.json` or `package.json` (it expires in an hour and breaks later deploys); prints the swap to the stable URL
- the handler route exists (`app/api/shipcue/[...path]/route.ts`, or `--route <file>`)
- the env vars the route reads (default `DATABASE_URL`, `SHIPCUE_TOKEN`) are in `.env*`, your shell, and on Vercel when the project is linked (`vercel env ls`); values are never printed
- with `--url`: `GET /capabilities` answers 200, the agent API answers 200 with `SHIPCUE_TOKEN`, and (with `DATABASE_URL` and the app's `pg`) `shipcue_reports` and `shipcue_report_events` exist with RLS on, every column in `sql/schema.sql` and the current history actions; a gap prints the "Upgrading from …" block to run

**shipcue Cloud.** `npx shipcue init --cloud pk_…` prints the env line (`NEXT_PUBLIC_SHIPCUE_ENDPOINT`) and a small `ShipcueButton` client component for a Next.js app; `--write` adds both, never overwriting.

## HTTP API

| Method | Path | Who |
|---|---|---|
| `POST` | `/reports` | the button (multipart form) |
| `POST` | `/reports/:id/video` | the button, the reporter only (multipart, field `video`; needs `saveVideo`) |
| `GET` | `/reports?status=open` | agent, bearer token |
| `GET` | `/reports/:id` | agent |
| `POST` | `/reports/next/claim` | agent |
| `POST` | `/reports/:id/claim` | agent |
| `POST` | `/reports/:id/release` | agent |
| `POST` | `/reports/:id/close` | agent, `{ status: "fixed" \| "wontfix", resolution, prUrl? }` |
| `POST` | `/reports/:id/heartbeat` | agent: renew its lease |
| `POST` | `/reports/:id/review` | agent, `{ prUrl }`: a PR is up, the report is in review |
| `GET` | `/reports/:id/events` | agent: the report's history |
| `GET` | `/reports?mine=1` | agent: what it holds or has queued |
| `POST` | `/reports/:id/note` | agent, `{ text }`: a note on the report's history |
| `POST` | `/reports/:id/merge` | agent, `{ into }`: close it as a duplicate of another report, with a note on both |
| `POST`/`PUT` | `/reports/:id/scope` | agent holding it, `{ scope }` (null clears): what its claim touches |
| `GET` | `/reports/conflicts` | agent: active claims whose work areas overlap, and `free` |
| `POST` | `/digest` | agent, `{ since?, until?, every? }`: the last period's digest, sent or returned (with the `digest` option) |
| `GET` | `/team/me`, `/team/reports`, `/team/reports/:id`, `/team/conflicts` | signed-in members, with the `team` option |
| `POST` | `/team/reports/:id/{claim,assign,release,close,reopen,review,priority,note,edit,merge}` | members (not viewers) |
| `GET` | `/board` | anyone, only with `board` on: the queue and the changelog |
| `GET` | `/board/version` | anyone, only with `board` on: a short string that changes when any report does |
| `GET` | `/mine` | the signed-in reporter, only with `reporterPortal`: their own reports and how each was fixed |
| `GET` | `/capabilities` | the button: what this handler takes (video, files, limits), and `version`, the shipcue it runs |
| `POST` | `/github` | a GitHub `pull_request` webhook, only with `github` on (signed with its secret) |

## Queue and changelog pages

Switch on `board` in the handler (`true`, or `(req) => boolean` to limit who sees it), then render `<ShipcueBoard endpoint="/api/shipcue" />` (or `<ShipcueQueue />` / `<ShipcueChangelog />`) from `shipcue/react`. It lists open and in-progress reports, most urgent first, and fixed ones with their resolution, latest first. No reporter, page, diagnostics or attachments ever leave the server. Close reports with a one-line, user-facing `resolution` and the changelog writes itself. With both lists it shows Open / Fixed / All / Changelog pills with counts, and a small View control lets each viewer switch to tabs or a compact list (`tabStyle`, `layout`, `viewPicker`) (`initialView` sets where it starts). Add `boardScreenshots: true` to show each report's screenshots too: off by default, since screenshots can show private things. The board is live: it checks a tiny `/board/version` every 5 seconds while the page is in view and re-reads as soon as a report is filed or changes (`liveMs`, 0 turns it off). The Changelog is grouped by the day each fix shipped. Two opt-ins: `filters` adds a search box and a type picker, and `syncUrl` keeps the tab in the URL (`?view=changelog`) so it can be linked.

## The CueLog table

For the team: every report in full, claimed and worked by people and agents together. Give the handler a `team` option, `{ getMember: (req) => ({ id, name, role: 'owner' | 'member' | 'viewer' }) | null, claimants: (req) => [{ kind: 'person' | 'agent', id, name }] }`, and render `<CueLogTable endpoint="/api/shipcue" />` from `shipcue/react` on a signed-in page. It has Open / Mine / In review / Fixed / All pills, filters (type, priority, who has it, search), sorting (queue order, longest waiting, recently updated, claimant), a List and a Board view (drag between columns), inline priority and assignee, bulk actions, and a side panel with screenshots, the app snapshot, the agent prompt and the report's history. Unowned work says "Nobody yet" in amber, and the "Claimed by" filter's *Nobody has looked* keeps open reports nobody holds and nothing has happened to since they were filed; an agent's lease and a stale claim show as badges. Assigning to an agent queues the report for it: its `claim_next_report` returns that report first. Every change is kept in `shipcue_report_events`. Members can **Edit** a filed report from the drawer (text, type, area, and once it is closed, what changed), checked against your config and logged as `edited` (`store.edit`, `POST /team/reports/:id/edit`); Edit offers the handler's areas, so the `areas` prop is optional. Context drawn as an outline has a Preview / Raw switch, a report's PR shows on its row, and the list leaves diagnostics out (the drawer reads them with the report). **Merge** folds a duplicate into the original (`POST /team/reports/:id/merge { into }`, members only): the duplicate closes as won't fix with "Duplicate of #<id8>", both reports get a note, and the original's note counts the duplicate's reporters (never who they are); `into` must be a report the same store can see, so a Cloud project can't merge into another's. A note can carry suggestions in its detail (`store.note(id, text, by, { suggest: { priority?, area?, duplicateOf? } })`, as Cloud's hosted agent does): the drawer shows them as small **Apply priority**, **Apply area** and **Merge into #id8** chips, each a normal team API call under the member, logged in the history; nothing is applied without a click. Opt-ins: `syncUrl` keeps the tab and the open report in the URL (`?tab=fixed&report=<id>`) and adds Copy link; `hotkeys` turns on `/` search, `j`/`k` move, Enter opens, `p` pins.

Or use [shipcue Cloud](https://shipcue.ibuildathing.com/cloud/): the same table, hosted, with projects, invites and agent tokens.

## Chrome extension

Report what you see on any page, even sites you do not run: the extension in `extension/` sends your words with a screenshot of the tab, the element you click (selector, text, position, HTML), the text you selected, and the time, time zone, window size and, if you tick it, your location, to any shipcue endpoint. Download it from [shipcue.ibuildathing.com/extension](https://shipcue.ibuildathing.com/extension/), unzip, and load it at `chrome://extensions` → Developer mode → Load unpacked. Set your app's endpoint under ⚙ (it sends to shipcue's own CueLog until then).

## Broadcast and listen

Tell people or agents when something happens to a report. Each broadcaster gets the events it lists (`report.filed`, `report.claimed`, `report.released`, `report.closed`, `report.video`), after the change is saved; one that fails or is slow is logged and never fails the request.

```ts
import { createShipcueHandler, slack, webhook } from 'shipcue/server';

createShipcueHandler({
  // ...
  broadcasters: [
    slack({ webhookUrl: process.env.SLACK_WEBHOOK!, link: 'https://app.example.com/reports' }),
    // Zapier, n8n, an email or SMS bridge, or an agent on a VPS, Mac mini or Tailscale address.
    // Signed: check x-shipcue-signature with signBody(secret, rawBody).
    webhook({ url: 'https://mac-mini.tailnet.ts.net/shipcue', secret: process.env.HOOK_SECRET, events: ['report.filed'] }),
    // Or anything: { name: 'sms', events: ['report.filed'], send: async (e) => sendText(describeEvent(e)) }
  ],
});
```

An agent that would rather not open a port listens instead: `shipcue-listen` polls the queue with the agent token and runs a command per event, with the event as JSON on stdin and `SHIPCUE_EVENT` / `SHIPCUE_REPORT_ID` in its environment, one at a time.

```bash
SHIPCUE_URL=https://app.example.com/api/shipcue SHIPCUE_TOKEN=... \
  npx shipcue-listen --on filed -- claude -p "Fix the newest report in the shipcue queue"
# --on filed,assigned,claimed,released,closed,video   --every 15 (seconds)   --backlog   --once
# --scope '{"paths":["src/server/**"]}'   the work area this agent's claims declare (SHIPCUE_SCOPE for shipcue-mcp)
# No command: prints one JSON line per event.
```

`assigned` fires when someone queues a report for this agent in the CueLog. To keep a listener running as a daemon, shipcue Cloud's Setup tab writes it out for you (Run a listener): the one-line command, a macOS launchd agent (KeepAlive, logs in `~/Library/Logs`) or a Linux systemd `--user` unit, with the agent's token filled in.

**One digest instead of a message per event.** Turn on `digest` and a cron (Vercel Cron, GitHub Actions, launchd) calls `POST {base}/digest` with the agent token every hour or day. It builds one summary of the last period from the report history: filed, fixed (with the fix line and PR), reopened, claims stuck past their lease, how many are still open and the oldest waiting, and sends it with `slackDigest({ webhookUrl })`, `emailDigest({ to, send })` (the same `send` as `emailReporter`) or your own `{ name, format, send }`. Without `send` it returns the digest as Markdown, for a daily note or an outliner log. Quiet periods send nothing unless `sendEmpty`. It never includes who filed a report, the page, diagnostics or attachments. `digest(store, { since, until, format: 'slack' | 'email' | 'markdown' })` builds one anywhere.

```ts
createShipcueHandler({ /* ... */ digest: { every: 'day', send: slackDigest({ webhookUrl: process.env.SLACK_WEBHOOK! }), link: 'https://app.example.com/reports' } });
// curl -X POST https://app.example.com/api/shipcue/digest -H "Authorization: Bearer $SHIPCUE_TOKEN"   (body: { since?, until?, every? })
```

## Close the loop with GitHub

Let pull requests move reports instead of calling `review` and `close` by hand. Give the handler a secret:

```ts
createShipcueHandler({
  // ...
  github: {
    secret: process.env.SHIPCUE_GITHUB_SECRET!,
    // Optional: close only once production serves the merge commit.
    liveCheck: { url: 'https://app.example.com/api/version' },
  },
});
```

Then in the repository: **Settings → Webhooks → Add webhook**, Payload URL `https://your.app/api/shipcue/github`, Content type `application/json`, the same Secret, and **Let me select individual events → Pull requests** only. Name the report in the PR's title, body or branch, by its full id or its first 8 characters (`fix/919f5ca2-github-loop`); ids that are not reports in this store are ignored.

| Pull request | Report |
|---|---|
| opened, reopened, edited, synchronize, ready for review | open or claimed → In review with the PR link (a claimant keeps it) |
| merged | → Fixed, "Merged in #N", with the PR link (closed reports stay as they are) |
| merged, with `liveCheck` | stays In review until `url` serves the merge sha (its first 7 characters, or your `match(body, sha)`), then Fixed, "Merged in #N, live in abc1234" |
| closed without merging | In review under this PR → back in the queue, unassigned |

The history names `github (@login)` as an agent. shipcue runs no timers: `liveCheck` is checked when the board, the CueLog or an agent reads the queue (at most once per `everyMs`, a minute by default), or call `handler.checkLive()` from a cron. On shipcue Cloud, Setup → Close the loop with GitHub gives the project's webhook URL (`/api/cloud/p/<key>/github`) and its secret, shown once.

## Try it locally

```bash
pnpm install && pnpm build
SHIPCUE_TOKEN=dev node examples/demo-server.mjs
```

## Development

```bash
pnpm test        # vitest; the Postgres store runs against real Postgres via PGlite
pnpm typecheck
pnpm build
```

## Publishing

Maintainers publish from a clean `main` (the build runs on `prepublishOnly`, so installing shipcue never builds anything):

```bash
npm login
npm publish --access public
```

Release tarballs for GitHub: `npm run pack:release` (builds, then `npm pack`).

## Changelog

- **0.30.0** (unreleased): Keys (shipcue report 2532c428): a small Keys button next to Dictate records the key combinations you press and writes them into the report at the caret as text (`⌘ + Enter`, `⌃ + ⇧ + D` on a Mac; `Ctrl + Shift + D` elsewhere), several in a row until Esc or a second click ("Press keys… (Esc to stop)"). While it listens, shipcue's hotkeys (⌘J ⌃B ⌃F) and ⌘↵ are written, not run. Works with `renderDescription`. New text keys `keys`, `keysRecording`, `keysHint`. No new dependency, no schema change.
- **0.29.0**: `renderDescription={(p) => <YourEditor {...p} />}` draws the Bug and Feature request description your own way (Habitect report 0cda1413), e.g. your app's outline editor. It gets `value` and `onChange` (what it sets is what is sent), `type`, `placeholder`, `submit` (what ⌘↵ does), `addFiles` (what pasting a screenshot does) and `textarea`, shipcue's own text box on the same text, for a switch back to plain text. Drawn inside a `[data-shipcue-description]` box. Off unless given; no new dependency.
- **0.28.1**: a report's detail view (Yours, `LocalReports`) shows its first line once, as the title, instead of again at the top of the text.
- **0.28.0**: open what you sent from the Yours list, even without a server (shipcue report fec27a48). The panel now keeps the full report sent from this browser (description, type or extra tab, priority, area and its label, page, context capped at `MAX_KEPT_TEXT` (4,000 characters), screenshot and file counts, video yes/no, alt texts, time; never screenshot or video data), capped at `MAX_MINE` (50) with a size guard (`MAX_MINE_BYTES`, the oldest dropped, and again if the browser's quota is hit). Old `shipcue:mine` entries still read, and just show less. Each Yours item is a button that opens a read-only detail inside the panel (type, priority and area chips, status, fix line and PR from `GET /mine` when offered, page link, text, context as an outline preview, attachment counts; pins work there; Back returns). New: `<LocalReports />` (and `ReportDetail`, `MAX_MINE`) from `shipcue/react`, the same list and detail from local storage only, for pages with a custom `submit` or offline. New text keys: `unpin`, `openIt`, `reportDetails`, `back`, `filed`, `screenshotAttached`, `screenshotsAttached`, `fileAttached`, `filesAttached`, `videoAttached`. No new dependency, no schema change; no editing or re-sending from the detail, nothing synced.
- **0.27.0**: retry-safe filing (shipcue report 9833fd28): one report per draft, even when the network or database stalls. The panel sends an `idempotencyKey` with each report, kept across retries of the same draft (a failed send, a timeout) and renewed after a successful send or for a new report (a fresh open, a cleared draft); custom `submit` props get it in their FormData. The handler passes it to the store, which files a key once per project and answers a repeat with the original report (same id, `200 { id, replayed: true }`; no second row, `onReport`, broadcast or reporter email), race-safe (`INSERT … ON CONFLICT DO NOTHING`, then the row already there). Invalid keys (over 100 characters, odd characters) are ignored. Stores: `NewReport.idempotencyKey`, `CreatedReport` (`replayed?: true`); core: `cleanIdempotencyKey`, `newIdempotencyKey`. No new dependency, no fuzzy duplicate matching, no offline queue. **Upgrading (postgresStore, e.g. Stanford Founders network): run the new "Upgrading from 0.26" block of `sql/schema.sql` (or the whole file again; it is safe to repeat) to get the protection. It only adds a nullable `idempotency_key` column and a partial unique index. Without it nothing breaks: reports file as before, just without the dedupe.** Cloud: also in `sql/cloud.sql` (unique per project).

- **0.26.2**: `sql/schema.sql` can be run again on a database whose history already has `edited` entries (the 0.18 block no longer narrows the action check before the 0.20/0.21 block widens it). `shipcue doctor` finds a Pages Router route (`pages/` or `src/pages/api/shipcue/[...path].ts`).
- **0.26.1**: the resize grip is easier to find: a bigger corner target (22px, 32px on touch) with a darker glyph, and Display now says which corner to drag ("Resize the panel by dragging its top-left corner").
- **0.26.0**: one view of every queue (shipcue report e4e1a85e). `/capabilities` returns `version`, the installed shipcue, from `SHIPCUE_VERSION` (exported from `shipcue`, set from package.json at build time), with `compareVersions`. shipcue Cloud opens on **All projects** for anyone on two or more: per project open / claimed / in review, "waiting 2d" for the oldest open report, claims stuck past their lease, and a **Nobody has looked** filter (open, never claimed, assigned or noted), each linking to its CueLog; an optional app URL per project (Setup → Settings) shows "shipcue 0.17.0 · behind 0.25.0", read server-side with a short timeout and cached, "unknown" when the app does not answer. The CueLog's "Claimed by" filter gains *Nobody has looked* (`nobodyLooked`). **Upgrading (Cloud):** run the new `app_url` line in `sql/cloud.sql`.
- **0.26.0**: work-area claims, the first part of swarm mode (shipcue report 83f5d976; design in [docs/swarm.md](docs/swarm.md)). A claim can carry a `scope` (`areas`, `paths` globs, `migration` slot, `branch`) on `POST reports/:id/claim` and `reports/next/claim`, and `POST|PUT reports/:id/scope` changes it (holder only; null clears). `GET reports/conflicts` (agent) and `GET team/conflicts` (members) list pairs of active claims whose scopes overlap (same area, glob paths that can match one file, same migration slot or branch) plus `free` when nothing is claimed or in review; a claim's response carries its conflicts as a `warning`, never a refusal. The CueLog shows "overlaps #id8" on those rows. MCP: `scope` on `claim_report` / `claim_next_report`, new `set_report_scope` and `list_conflicts`, and a default from `SHIPCUE_SCOPE`; `shipcue-listen --scope '<json>'` sets it for its command. Stores: `ClaimOptions.scope`, `store.setScope`, `store.scopes`; the scope is kept in the history (the claim's event, then a note), so **no schema change**. "Work this queue" (N reports to N listeners on one board) is design only.
- **0.26.0**: reporter portal (shipcue report 3d0d7995): your reports and their status on any device. The handler's opt-in `reporterPortal` adds `GET {base}/mine`, the signed-in reporter's own reports (status, type, first line, fix line, PR, dates; never anyone else's, never diagnostics), and `/capabilities` says `mine: true`, so the panel's Yours list merges them with this browser's (one per id; pins stay local; new text keys `wontFix`, `noReportsYetAnywhere`). Turn it on only when `getReporter` reads a verified session: not for the button's `reporter` prop, so shipcue Cloud projects skip it. `emailReporter({ mineLink })` links it from the it-is-fixed email; `ListFilter.reporter` filters a store by reporter; board items carry `id="shipcue-<id>"` and a `#shipcue-<id>` link scrolls to one. shipcue's own site: **My reports** at `/app/mine/` for signed-in Cloud accounts. No schema change.
- **0.25.0**: the Send button keeps one size and shape while sending (shipcue report fa76b7ff): the label stays "Send" and only the ⌘↵ hint turns into "…" (screen readers hear "Sending…"), replacing 0.24.1's wider reserved label, which looked lopsided. A send that is still pending can't be started again.
- **0.25.0**: one-click suggestions and duplicate detection (shipcue report 1c0bf5be). Merge a duplicate: `POST /team/reports/:id/merge { into }` (members, not viewers) and `POST /reports/:id/merge` for agents (MCP `merge_report`) close it as won't fix with "Duplicate of #<id8>", note both reports, count the duplicate's reporters on the original (never emails) and refuse a report the store can't see (another Cloud project), a closed duplicate or a target that is itself a duplicate. `store.note(id, text, by, extra?)` keeps `extra` beside the text in the event's detail. The CueLog drawer shows a note's `detail.suggest` as Apply chips (priority, area via Edit, Merge into #id8); `readSuggestion` drops values that don't fit. shipcue Cloud: the hosted agent's triage also gets the project's open reports (first 8 characters of the id and the headline, newest first, `SHIPCUE_HOSTED_DUPLICATE_CANDIDATES`, 50 by default, 0 turns it off) in the same OpenAI call, may answer "looks like #id8", and stores its priority, area and duplicate suggestions with its note. No schema change: merges are a `closed` event and notes.
- **0.25.0**: close the loop with GitHub (shipcue report 919f5ca2). The opt-in handler option `github: { secret, liveCheck? }` turns on `POST {base}/github` for a repository webhook (signed, `X-Hub-Signature-256`): a pull request whose title, body or branch names a report (full id or its first 8 characters, only reports in this store) moves it to In review with the PR link, merging it closes it as fixed ("Merged in #N"), and closing it unmerged puts reports in review under it back in the queue. With `liveCheck: { url, match? }` a merged report waits in review until that URL serves the merge commit, then closes as "Merged in #N, live in <sha7>"; it is checked on board, CueLog and agent reads (at most once a minute) or by `handler.checkLive()` from your cron. History events name `github (@login)` as an agent. shipcue Cloud: Setup → Close the loop with GitHub gives each project a webhook URL and a secret shown once (`sql/cloud.sql` adds `cloud_projects.github_secret`). New exports: `verifyGitHubSignature`, `reportIdsIn`, type `ShipcueHandler`.
- **0.25.0**: isolation regression suite for Cloud (shipcue report 407a5d6d). `tests/isolation.test.ts` runs every read and write path (store methods, the public board, its version and screenshots, the team API, the agent API, the button's video route, and Cloud's per-project queue at `/api/cloud/p/<key>/`) with two Cloud projects and an own-rows store (`project: null`) on one database, and checks nothing crosses over in any direction, so the 0.16.1 leak (the site's own queue reading every Cloud project's reports) cannot come back unnoticed. No leak found; tests only.
- **0.25.0**: setup without the traps (shipcue report 5fdbd60f). `npx shipcue doctor` checks the install and version, the signed-URL lockfile trap, the handler route and the env vars it reads (Vercel's too), and with `--url` the live endpoint, the agent token and the tables (RLS, columns, history actions), printing the fix or the "Upgrading from" block for each ✗. `npx shipcue init --cloud <pk_…>` wires the button to a Cloud project. Ready for npm: `prepare` became `prepublishOnly` (nothing builds on install), plus `publishConfig` and a `./package.json` export; see Publishing.
- **0.25.0**: activity digest (shipcue report 5f4d339b): one batched summary per hour or day instead of a message per event. `digest(store, { since, until, format })` builds it from the report history (filed, fixed with fix lines and PRs, reopened, claims stuck past their lease, still open, oldest waiting) as Slack, email or Markdown, never with reporters or diagnostics; the handler's opt-in `digest` option adds `POST {base}/digest` (agent token) for a cron, sending with `slackDigest` / `emailDigest` or returning Markdown. shipcue Cloud: Setup → Digest (off / hourly / daily, to the project's Slack or the owner's email), sent by a cron at `/api/cloud/digest`. **Upgrading (Cloud):** run the new digest lines in `sql/cloud.sql`.
- **0.24.2**: when key presses on the resize grip come quicker than the panel redraws, each one now counts (shipcue report ee970b18).
- **0.24.1**: the Send button keeps its size while sending: "Sending…" no longer wraps it onto two lines or makes it taller.
- **0.24.0**: resize the panel (shipcue report ee970b18). A small grip on the floating panel's free corner (the one away from the button, so it follows the quadrant) resizes it by drag, or by the arrow keys once focused (Shift for bigger steps); the text box takes the extra height. At least the default size, at most 8px inside the window, scaled with the text size, kept in this browser (`shipcue:panel-size`); Reset position (⌃⇧H or Display) also resets the size, and is now offered with `movable={false}` too. New: prop `resizable` (on by default for the floating panel); text key `resizePanel`.
- **0.23.0**: adjust before capturing (shipcue report 03de1f12). Letting go of the drag no longer captures at once: the selection stays with eight resize handles, moves when dragged from inside, and has a small dark toolbar with editable width × height, **Capture** (Enter, attaches it as it is), **Capture & annotate** (opens the annotator) and Cancel (Esc); a new drag outside starts over. The same in Select area and on the tint that comes with the panel (there Esc first drops the selection, keeping the tint). The browser's "see this tab?" prompt comes only at Capture, and the granted share is reused for later captures while the panel is open (stopped when it closes, the page hides, or after `captureKeepAlive` ms idle, 120000 by default; an ended share is asked for again). New: prop `captureKeepAlive`; text keys `adjustHint`, `selectionToolbar`, `selectionWidth`, `selectionHeight`, `captureNow`, `captureAnnotate`; exports `tabCapture` and `CAPTURE_KEEP_ALIVE_MS`. **Upgrading:** `AreaSelect`'s `onSelect` now gets `(rect, { annotate })` once the person confirms, not on release; `captureArea` still captures once and stops.
- **0.22.1**: `selectArea()` starts Select area from your app (a command palette, a menu), like `openReport()`. `agentPromptAuth={{ header: 'Authorization: Bearer <token>', where: '<token page>' }}` tells "Copy prompt for my agent" that your endpoint needs a token: the header goes on its curl, `SHIPCUE_TOKEN=<token>` on its `claude mcp add` line, plus where to get one (placeholders only, never a real token). Both are opt-in; asked for by Habitect.
- **0.22.0**: what Habitect's Reports page grew, brought to the CueLog (shipcue report 5c54da74). **Edit a filed report** from the CueLog drawer: text, type and area, and once it is closed, what changed (`store.edit`, `POST /team/reports/:id/edit`, an `edited` history event; Esc cancels, ⌘↵ saves). Context drawn as an outline gets a Preview / Raw switch, the report's PR shows on its row, `/team/me` returns the config's areas, and `GET /team/reports` leaves diagnostics out (the drawer reads them with the report). Opt-in: `syncUrl` (tab and open report in the URL, plus Copy link) and `hotkeys` (`/`, `j`/`k`, Enter, `p`) on `CueLogTable`; `filters` (search and type) and `syncUrl` (`?view=`) on `ShipcueBoard`. The board's Changelog is grouped by day. **Upgrading:** run the "Upgrading from 0.20/0.21" lines at the end of `sql/schema.sql` (it widens the history's action check to take `edited`; no new columns). Until then, Edit fails and everything else works.
- **0.21.0**: area capture comes with the panel (shipcue report 503aa011). When the floating panel opens, the page is tinted and a drag anywhere on it captures that part into the annotator, with no hotkey or button; a click or tap on the tint, or Esc, lifts it (the panel stays open; a second Esc closes it), and the Select area tile or ⌃⇧A brings it back. New prop `captureOnOpen`, **on by default** for the floating panel (including `trigger={false}`), off for `variant="inline"`. `dimOnOpen` is deprecated: it still works, and with capture on it shows once the capture tint is lifted. New text key `captureOnOpenHint`; `AreaSelect` takes `ambient`, `onDismiss` and `clickSlop`. **Upgrading:** apps inherit the tint when they bump (Habitect, which passes `hotkeys={false}` and `pin={false}`, included); pass `captureOnOpen={false}` to opt out.
- **0.20.0**: notes on a report: a `note` action in `shipcue_report_events`, `store.note(id, text, by)`, `POST /team/reports/:id/note` (members, not viewers) and `POST /reports/:id/note` for agents, the MCP tool `add_note`, and the CueLog drawer shows notes in full with an Add note box (`maxNote`, 4,000 by default). `shipcue-listen --on assigned` hears reports queued for its agent. shipcue Cloud: **Run a listener** in Setup (pick or create an agent, events and command; copy it as one command, a launchd agent or a systemd unit) and a **hosted agent**, `shipcue-agent`, that triages reports assigned to it (or every new one) on OpenAI and leaves a note: summary, likely area, suggested priority, steps to reproduce and a plan for a coding agent (shipcue report 3d2dded6). **Upgrading:** run the "Upgrading from 0.18" lines at the end of `sql/schema.sql`; Cloud also runs the new lines in `sql/cloud.sql`.
- **0.19.0**: dragging the panel by its title moves the whole widget, button and panel together, with one saved position (the button's); the panel stays on screen and flips above or below the button when you let go (shipcue report 30beb674; the 0.17 `shipcue:panel-offset` key is cleared). New **Copy prompt for my agent** link: a prompt for Claude Code or Codex that fills the report out and files it, and a new MCP tool `file_report` (`createAgentClient().file()`) that needs no token (shipcue report 9f533ece). New text keys: `copyAgentPrompt`, `copyAgentPromptHint`, `copied`, `copyFailed`.
- **0.18.0**: Select area (⌃⇧A / Alt+Shift+A): tint the page, drag out part of it, and it is captured from the tab and opened in a CleanShot-style annotator (draw, arrow, box, highlight, text, blur, crop, colours, line widths, undo/redo, clear) with alt text that travels with the screenshot (`screenshotAlt`, `maxAltText`) and shows on the board, the CueLog and the preview. Pasted screenshots can be marked up too (the pencil on each). `dimOnOpen` tints the page while the panel is open. New exports: `Annotator`, `AreaSelect`, `captureArea`, and `shotAlt` / `withShotAlt` from `shipcue`.
- **0.17.1**: drag the panel by its title, as well as the button: it moves on its own, stays on screen, and is remembered in this browser. Reset position (⌃⇧H / Alt+Shift+H, or Display) puts both back; `movable={false}` keeps them still.
- **0.17.0**: `emailReporter({ send, appName, link, trust })` tells whoever filed a report when it is fixed, with the fix in one line and the PR (bring your own provider; only email reporters you have verified). shipcue Cloud projects can forward their reports to a Slack channel and/or a signed webhook, per event (Setup → Forward reports; `sql/cloud.sql` adds the columns).
- **0.16.2**: pins replace stars: a small Pin button next to Dictate pins the report you are writing (it stays at the top of Yours and the CueLog, and the form sends `pinned=1` for your own backend; `pin={false}` hides it for apps with their own pin control), and the board and CueLog table pin with Lucide's pin icon. A report's history keeps its order even when two changes share a timestamp (`shipcue_report_events.seq`; run the new line at the end of the 0.12 upgrade block in `sql/schema.sql`).
- **0.16.1**: `postgresStore(db, table, { project: null })` is an app's own queue in a table that also holds shipcue Cloud projects: it only sees rows with no project. Use it wherever one table serves both, so Cloud projects' reports never show on your board or to your agents.
- **0.16.0**: `formExtras` draws an app's own small controls (e.g. a "Pin it" checkbox) under the text box in the Bug and Feature request forms, and `fields` (read at send time) adds their values to the report, never over shipcue's own fields.
- **0.15.0**: `ReportButton` takes `reporter` (who is signed in on your site, e.g. `reporter={user.email}`) and sends it in the `x-shipcue-user` header with the report and its video, so shipcue Cloud's CueLog shows who filed each report. Your own handler can read it in `getReporter`. shipcue Cloud also gains Continue with Google and GitHub, enforces each project's list of sites, and lets owners rename a project, give the button a new key, or delete the project.
- **0.14.0**: the CueLog gets stars (pin any report to the top in the panel, the board and the CueLog table; the panel's new Yours list shows what you sent from this browser), an in-page image preview for screenshots everywhere (click to zoom, arrows, Esc), GitHub links on the changelog when the repository is public or the viewer is an admin (`boardLinks`, `boardAdmin`), `anonymousLimit` (a few reports without signing in, then `signInUrl`; signed in, people can still send anonymously), button and text sizes with a Display panel (`buttonSize`, `textSize`) and a hotkey to reset a dragged button (⌃⇧H / Alt+Shift+H). The hat is now Lucide's hard-hat. **Upgrading:** for `anonymousLimit`, run the "Upgrading from 0.13" lines in `sql/schema.sql`.
- **0.13.0**: the CueLog's claim model. A claim names a person or an agent (`claimantKind`, `claimantId`), agents can have their own tokens (`agents`), agent claims can have a lease (`leaseSeconds`, `heartbeat`), a PR puts a report `in_review`, and every change goes to `shipcue_report_events`. New `team` API and `CueLogTable` component; new MCP tools `submit_for_review`, `heartbeat_report`, `list_my_reports`. **Upgrading:** run the "Upgrading from 0.12" lines at the end of `sql/schema.sql` before deploying (new columns, the `in_review` status and the events table). shipcue Cloud's tables are in `sql/cloud.sql`.
- **0.12.0**: building blocks for a hosted queue (shipcue Cloud): `postgresStore(db, table, { project })` keeps every read and write to one project in a shared table (`sql/cloud.sql` adds `project_id`), and the handler's `cors` option takes reports from listed origins. Both are opt-in; self-hosted apps don't change.
- **0.11.0**: shipcue's mark is now a builder's hard hat (with its headlamp) on the button, the site and the extension; `icon="ship"` keeps the sailboat, `launcherIcon` takes your own. Dictate: a small mic beside the text box (⌃M on a Mac, Alt+Shift+M elsewhere, even with the panel closed) speaks into the report with the browser's own speech recognition; hidden where the browser has none.
- **Extension 0.1.1**: the hard-hat icon.
- **0.10.5**: a quick drag of the button works too (the pointer is held from the press).
- **0.10.4**: drag the floating button anywhere on the page; it stays where you leave it (kept in your browser) and the panel opens toward the middle of the screen. `movable={false}` pins it bottom-right.
- **0.10.3**: in Tabs view only the current tab is underlined (others no longer keep a grey line once visited); shipcue's CueLog opens on the Changelog.
- **0.10.2**: `launcherIcon` puts your own mark on the button in place of the sailboat (the accent background stays).
- **0.10.1**: "+ Add context" under the text box: what your app says is selected (as a preview), or an empty box to type or paste into, on any tab.
- **Extension 0.1.0**: a Chrome extension that reports from any page with a screenshot, a picked element, the selection and page details (time, time zone, location if you allow it). Download at /extension/.
- **0.10.0**: `text`: every word the panel and the board show can be your app's own (tab names, headings, placeholders, buttons, links, the thanks note, empty states); `DEFAULT_TEXT` lists them. `pastReportsLabel` and `seeReportsLabel` still work.
- **0.9.0**: the Context box has a Preview / Raw switch: an outline shows as bullets with nesting, `[[links]]`, `#tags` and `((refs))` set apart; pass `renderContext={(text) => <YourRenderer text={text} />}` to draw it your app's way.
- **0.8.1**: the thanks note says "See your CueLog"; shipcue's own queue page is now CueLog, at /cuelog/.
- **0.8.0**: broadcasters (`slack()`, signed `webhook()`, or your own) hear when a report is filed, claimed, released, closed or gets a video; `shipcue-listen` runs a command per event for agents on a Mac mini, VPS or Tailscale without opening a port; the board updates live (`/board/version`, `liveMs`); list mode stays inside its column.
- **0.7.0**: the board has a small View control, so each viewer picks pills or tabs and cards or a one-line list (kept in their browser; apps set the default with `tabStyle` and `layout`, or hide it with `viewPicker={false}`); the thanks note says "See your cue" (`seeReportsLabel`); shipcue's own Changelog page is now Cue, at /cue/.
- **0.6.9**: `onEditShortcuts`: apps whose own keymap opens shipcue (`hotkeys={false}`) get the panel's Shortcuts link too, opening their shortcut editor.
- **0.6.8**: no hard-coded limits in the panel: it reads how many screenshots, how big, and how long a video may be from the handler (`/capabilities`, i.e. your `resolveConfig`), and apps that send reports with `submit` pass `limits={{ maxScreenshots: 20 }}`.
- **0.6.7**: big videos fail gracefully: the button checks against the handler's real limit (`maxVideoBytes` from `/capabilities`; videos posted to the handler are capped at one request, `maxRequestBytes`, 4.4 MB by default) and says so before sending, keeping what was typed; size refusals from storage become a plain sentence, and the report is still filed.
- **0.6.6**: the panel grows and shrinks with what is in it; paste or drop a video straight into the text box; `allowFiles` takes other files (PDFs, logs) too; `GET /capabilities` tells the button what the handler takes, so it never offers a video it cannot send; `acceptVideoUrl` takes videos uploaded straight to your storage (past Vercel's 4.5 MB request limit); clear errors instead of "Not found".
- **0.6.5**: the board's Open / Fixed / All / Changelog tabs are pills again.
- **0.6.4**: the board's tabs are Open / Fixed / All / Changelog with counts; a small Shortcuts link in the panel lets each person change the hotkeys, saved in their browser.
- **0.6.3**: the board has a Queue / Changelog toggle and can show screenshots (`boardScreenshots`, opt-in); `pastReportsLabel`; the Agent task tab reads "Delegate a task to your agent."
- **0.6.2**: the Queue keeps finished reports, greyed out under the open ones; the board takes the page's own type; no more "ResizeObserver loop" console error from the panel.
- **0.6.1**: `showParam` (e.g. `"shipcue"`) keeps the button and hotkeys off until the page is opened with `?shipcue=true`; the open panel keeps its height instead of jumping as you switch tabs or clear text.
- **0.6.0**: `<ShipcueBoard />` / `<ShipcueQueue />` / `<ShipcueChangelog />` and the opt-in `GET /board`; up to 10 screenshots per report (default, with a 4 MB total so a report fits a 4.5 MB request); hotkeys are caught before the page's own key handlers, so ⌘J always reaches the Agent task tab; reports carry `updatedAt`.
- **0.2.0**: screen recording and video attachments, recent errors in the snapshot, a don't-attach-page link, Past reports links, `attachVideo` on stores. Brought over from the report buttons in the Stanford Founders dashboard and Block Outliner.
- **0.1.0**: first release.

## Staying small

shipcue is a report button, a queue, and the tools to work it. A new feature earns a place only if it:

1. **Solves something people already do by hand,** and the report says what that is.
2. **Ships as its smallest useful version first.** Every backlog item names that version and what is out of scope.
3. **Is opt-in when it costs anything:** a prop, a handler option or a project setting, off unless it is the obvious default. The core button, handler and store stay as they are.
4. **Never runs code or hosts runners itself.** Agents do the work over the agent API and listeners; shipcue coordinates.
5. **Adds no runtime dependency** unless it truly can't be done without one.

If an idea fails these, it belongs in your app (through `formExtras`, `fields`, broadcasters or `onReport`) rather than in shipcue.

## Roadmap

The backlog lives on [shipcue's own CueLog](https://shipcue.ibuildathing.com/cuelog/) as low-priority reports, each with its smallest version and what it leaves out:

- Publish to npm (the package is ready; `shipcue doctor` shipped in 0.25.0)
- Swarm mode: work-area claims are in ([docs/swarm.md](docs/swarm.md)); "Work this queue" is next

## License

MIT
