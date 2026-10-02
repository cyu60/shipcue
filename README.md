<div align="center">

<a href="https://shipcue.ibuildathing.com"><img src="docs/banner.png" alt="shipcue: bug reports your coding agents can fix" width="100%"></a>

<br>

<a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-16203A?style=flat-square" alt="MIT license"></a> <img src="https://img.shields.io/badge/tests-74%20passing-2E5BFF?style=flat-square" alt="74 tests passing"> <img src="https://img.shields.io/badge/MCP-ready-FFD43B?style=flat-square&labelColor=16203A" alt="MCP ready"> <img src="https://img.shields.io/badge/Postgres-self--hosted-16203A?style=flat-square" alt="Self-hosted on Postgres">

# shipcue: Bug Reports Your Coding Agents Can Fix

**Drop-in report button** &nbsp;•&nbsp; **Queue in your own Postgres** &nbsp;•&nbsp; **Agents claim over MCP** &nbsp;•&nbsp; **One report, one agent**

🌐 [Website](https://shipcue.ibuildathing.com) &nbsp;•&nbsp; ☁️ [Cloud](https://shipcue.ibuildathing.com/cloud/) &nbsp;•&nbsp; 📖 [Docs](https://shipcue.ibuildathing.com/docs/) &nbsp;•&nbsp; 📝 [Blog](https://shipcue.ibuildathing.com/blog/) &nbsp;•&nbsp; ✉️ [Contact](https://shipcue.ibuildathing.com/contact/)

</div>

---

A drop-in bug report and feature request button whose inbox is a queue that people **and coding agents** both work from.

<p align="center"><img src="docs/report-button.png" alt="The shipcue panel: Bug, Feature request and Agent task tabs, priority, where, screenshots, screen recording, Send with ⌘↵, and a Powered by shipcue line" width="420"></p>

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
pnpm add shipcue
```

Until the first npm release is out, install the prebuilt release (nothing builds on install, so it works with pnpm on Vercel):

```bash
pnpm add https://github.com/cyu60/shipcue/releases/download/v0.5.2/shipcue-0.5.2.tgz
```

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

Use `variant="inline"` for a header or toolbar button on phones, where a floating bubble covers the controls. Pass `submit={(form) => myServerAction(form)}` to send through a server action instead of `fetch`.

What else the panel does:

- **Record screen or attach a video.** Recordings stop at 60 seconds. The video uploads after the report is filed; if it fails, the report is still filed and the panel says so. Pass `uploadVideo={(reportId, blob) => …}` to upload it yourself; otherwise it goes to the handler. With `submit` and no `uploadVideo`, video is hidden.
- **Recent errors.** Page errors, unhandled rejections and `console.error` calls from before the report are added to the snapshot as `recentErrors`. Turn off with `captureErrors={false}`.
- **The page.** The panel shows which page it will attach, with a "don't attach" link.
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

Text highlighted on the page comes along in an editable, removable **Context** box (or pass `getContext` to supply your app's selected rows or blocks), and agents get it as its own section of the task prompt. Change the keys with `hotkeys={{ task: ['Mod+J'] }}` ("Mod" is ⌘ on a Mac, Ctrl elsewhere), turn them off with `hotkeys={false}`, or open the panel from your own menu with `openReport('task')`. People can also change their own keys from the panel's small Shortcuts link; their choice is kept in their browser and wins over yours. If your app's own keymap opens shipcue (`hotkeys={false}`), pass `onEditShortcuts={openYourKeymapEditor}` and the link opens that instead.

### Your own tabs

An app with its own flow (say an agent-task composer backed by its API) can draw it as a tab in the same panel: `extraTabs={[{ id: 'agent', label: 'Agent task', render: ({ text, context, close }) => <TaskComposer … /> }]}`. Give it a hotkey with `hotkeys={{ agent: ['Mod+J'] }}` or open it with `openReport('agent')`; `onOpenChange` and `closeReport()` let the app follow and close the panel. If the app already has a help button, `trigger={false}` hides shipcue's own and the app opens the panel with `openReport('bug')`.

## 4. Let agents work the queue

```bash
claude mcp add shipcue \
  -e SHIPCUE_URL=https://your.app/api/shipcue \
  -e SHIPCUE_TOKEN=... \
  -- npx shipcue-mcp
```

Tools: `list_reports`, `claim_next_report`, `get_report`, `claim_report`, `release_report`, `close_report`.

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
| `POST` | `/reports/:id/close` | agent, `{ status: "fixed" \| "wontfix", resolution }` |
| `GET` | `/board` | anyone, only with `board` on: the queue and the changelog |

## Queue and changelog pages

Switch on `board` in the handler (`true`, or `(req) => boolean` to limit who sees it), then render `<ShipcueBoard endpoint="/api/shipcue" />` (or `<ShipcueQueue />` / `<ShipcueChangelog />`) from `shipcue/react`. It lists open and in-progress reports, most urgent first, and fixed ones with their resolution, latest first. No reporter, page, diagnostics or attachments ever leave the server. Close reports with a one-line, user-facing `resolution` and the changelog writes itself. With both lists it shows Open / Fixed / All / Changelog pills with counts (`initialView` sets where it starts). Add `boardScreenshots: true` to show each report's screenshots too: off by default, since screenshots can show private things.

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

## Changelog

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

## Roadmap

- Sinks: GitHub Issues, Linear, Slack, email
- Row-level security preset for apps that read the table from the browser
- Notify the reporter when their report is fixed
- Public board with voting for feature requests (optional)
- Comments on a report between the reporter and whoever claimed it

## License

MIT
