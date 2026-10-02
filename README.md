# fixqueue

A drop-in bug report and feature request button whose inbox is a queue that people **and coding agents** both work from.

<p align="center"><img src="docs/report-button.png" alt="The report button open on a feature request: bug or feature toggle, description, priority, where, screenshot upload and Send" width="420"></p>

Someone in your app clicks the button, says what broke or what they want, pastes a screenshot, and sends. fixqueue files it with the page address, browser and a snapshot of app state you choose. Then Claude Code, Codex or a teammate claims the most urgent report, gets a ready-made task prompt, fixes it, and closes it with the PR link.

```
user files a report  →  queue (your Postgres)  →  agent claims the top one  →  PR  →  closed as fixed
```

- **Self-hosted.** One table in your own Postgres. No third-party dashboard, no per-seat pricing.
- **Agent-ready.** Every report carries enough context to act on, and an MCP server lets agents pull from the queue without two of them ever taking the same report.
- **No CSS setup.** The button uses inline styles and takes an accent colour.

It started as the report button inside three apps (a founders dashboard, a hackathon platform and a block outliner) and was pulled out once the same five parts kept showing up: a button, a form, automatic context, storage, and somewhere for reports to go.

## Install

```bash
pnpm add fixqueue
```

## 1. Create the table

Run [`sql/schema.sql`](sql/schema.sql) on your database (Supabase, InsForge, Neon, RDS or local Postgres).

## 2. Mount the handler

Next.js App Router, `app/api/fixqueue/[...path]/route.ts`:

```ts
import { Pool } from 'pg';
import { createFixqueueHandler, postgresStore } from 'fixqueue/server';
import { resolveConfig } from 'fixqueue';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const handler = createFixqueueHandler({
  store: postgresStore(pool),
  config: resolveConfig({ areas: [{ value: 'editor', label: 'Editor' }, { value: 'billing', label: 'Billing' }] }),
  getReporter: async (req) => (await getSession(req))?.email ?? null, // your auth
  requireReporter: true,
  agentToken: process.env.FIXQUEUE_TOKEN, // leave unset to switch the agent API off
  onReport: async (report) => {
    // email the team, post to Slack, mirror to your task board...
  },
});

export { handler as GET, handler as POST };
```

The handler is a plain `(Request) => Promise<Response>`, so it also works in Hono, Remix, Bun, Deno and Cloudflare Workers. Screenshots are stored as data URLs unless you pass `saveScreenshot(file, key)` to upload them to S3, Supabase Storage or similar.

## 3. Add the button

```tsx
import { ReportButton } from 'fixqueue/react';

<ReportButton
  areas={[{ value: 'editor', label: 'Editor' }, { value: 'billing', label: 'Billing' }]}
  accentColor="#8c1515"
  diagnostics={() => ({ route: location.pathname, openDoc: store.docId, lastAction: store.lastAction })}
/>
```

Use `variant="inline"` for a header or toolbar button on phones, where a floating bubble covers the controls. Pass `submit={(form) => myServerAction(form)}` to send through a server action instead of `fetch`.

## 4. Let agents work the queue

```bash
claude mcp add fixqueue \
  -e FIXQUEUE_URL=https://your.app/api/fixqueue \
  -e FIXQUEUE_TOKEN=... \
  -- npx fixqueue-mcp
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
| `GET` | `/reports?status=open` | agent, bearer token |
| `GET` | `/reports/:id` | agent |
| `POST` | `/reports/next/claim` | agent |
| `POST` | `/reports/:id/claim` | agent |
| `POST` | `/reports/:id/release` | agent |
| `POST` | `/reports/:id/close` | agent, `{ status: "fixed" \| "wontfix", resolution }` |

## Try it locally

```bash
pnpm install && pnpm build
FIXQUEUE_TOKEN=dev node examples/demo-server.mjs
```

## Development

```bash
pnpm test        # vitest; the Postgres store runs against real Postgres via PGlite
pnpm typecheck
pnpm build
```

## Roadmap

- Sinks: GitHub Issues, Linear, Slack, email
- Row-level security preset for apps that read the table from the browser
- Notify the reporter when their report is fixed
- Public board with voting for feature requests (optional)
- Comments on a report between the reporter and whoever claimed it

## License

MIT
