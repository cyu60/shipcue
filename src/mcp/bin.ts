#!/usr/bin/env node
// MCP server so Claude Code, Codex or any MCP client can work the queue.
//   claude mcp add shipcue -e SHIPCUE_URL=https://app.example.com/api/shipcue -e SHIPCUE_TOKEN=... -- npx shipcue-mcp
// Without SHIPCUE_TOKEN only file_report works (filing needs no token; the queue tools do).

import { hostname } from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { describeOverlaps, otherSide, PRIORITIES, validateScope } from '../core';
import { createAgentClient } from './client';

const url = process.env.SHIPCUE_URL;
const token = process.env.SHIPCUE_TOKEN;
if (!url) {
  console.error('shipcue-mcp: set SHIPCUE_URL (and SHIPCUE_TOKEN to work the queue)');
  process.exit(1);
}

// SHIPCUE_SCOPE (JSON, e.g. from shipcue-listen --scope) is the work area claims declare by default.
const envScope = validateScope(process.env.SHIPCUE_SCOPE ? (JSON.parse(process.env.SHIPCUE_SCOPE) as unknown) : null);
if (!envScope.ok) {
  console.error(`shipcue-mcp: SHIPCUE_SCOPE: ${envScope.error}`);
  process.exit(1);
}
const client = createAgentClient({ url, token, agent: process.env.SHIPCUE_AGENT ?? `mcp@${hostname()}`, scope: envScope.value });
const server = new McpServer({ name: 'shipcue', version: '0.13.0' });

// What a claim says it touches (shipcue report 83f5d976, docs/swarm.md).
const scopeArg = z
  .object({
    areas: z.array(z.string()).optional().describe('Areas this work touches, e.g. ["sync"].'),
    paths: z.array(z.string()).optional().describe('File globs it will edit, e.g. ["src/server/**"].'),
    migration: z.string().optional().describe('The migration slot (timestamp) it takes, if any.'),
    branch: z.string().optional().describe('Its git branch.'),
  })
  .optional()
  .describe('What this work touches, so shipcue can warn when another active claim overlaps. Never blocks.');

/** The prompt, with the overlap warning on top when there is one. */
const claimedText = (c: { prompt: string; warning?: string }) => (c.warning ? `⚠ ${c.warning}\n\n${c.prompt}` : c.prompt);

const text = (value: unknown) => ({
  content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});

// A person's report, filled out by their agent (shipcue report 9f533ece): the panel's
// "Copy prompt for my agent" hands over the page, the snapshot and what they typed so far.
server.registerTool(
  'file_report',
  {
    description:
      'File a bug report, feature request or agent task for a person, with the same fields the shipcue panel sends. Ask them for anything missing first (what happened and what they expected, or what they want and why). Returns the new report id.',
    inputSchema: {
      type: z.enum(['bug', 'feature', 'task']),
      description: z.string().describe("The report in the person's words: for a bug, steps, what happened, what was expected."),
      priority: z.enum(PRIORITIES).optional(),
      area: z.string().optional().describe('One of the app areas the prompt lists; other when unsure.'),
      page_url: z.string().optional(),
      context: z.string().optional().describe('What the report is about, e.g. text picked out on the page.'),
      diagnostics: z.string().optional().describe('The app snapshot from the prompt, as JSON text, unchanged.'),
      reporter: z.string().optional().describe('Who it is from, if the person says.'),
    },
  },
  async ({ type, description, priority, area, page_url, context, diagnostics, reporter }) => {
    const { id } = await client.file({ type, description, priority, area, pageUrl: page_url, context, diagnostics, reporter });
    return text(`Filed ${id}.`);
  },
);

server.registerTool(
  'list_reports',
  {
    description: 'List bug reports and feature requests, most urgent first.',
    inputSchema: { status: z.enum(['open', 'claimed', 'in_review', 'fixed', 'wontfix']).optional() },
  },
  async ({ status }) => {
    const reports = await client.list(status ?? 'open');
    return text(
      reports.length
        ? reports.map((r) => `${r.id}  [${r.priority}] ${r.type} · ${r.area} · ${r.description.split('\n')[0]?.slice(0, 80)}`).join('\n')
        : 'The queue is empty.',
    );
  },
);

server.registerTool(
  'claim_next_report',
  {
    description:
      'Take the next report: one assigned to you first, then the most urgent open one. Returns a task prompt with the page, screenshots and app snapshot. If the queue gives claims a lease, call heartbeat_report while you work. Pass scope to say what you will touch.',
    inputSchema: { scope: scopeArg },
  },
  async ({ scope }) => {
    const claimed = await client.claimNext(scope);
    return text(claimed ? claimedText(claimed) : 'Nothing open. The queue is empty.');
  },
);

server.registerTool(
  'get_report',
  { description: 'Read one report as a task prompt.', inputSchema: { id: z.string() } },
  async ({ id }) => text((await client.get(id)).prompt),
);

server.registerTool(
  'claim_report',
  { description: 'Take a specific open report. Pass scope to say what you will touch.', inputSchema: { id: z.string(), scope: scopeArg } },
  async ({ id, scope }) => text(claimedText(await client.claim(id, scope))),
);

server.registerTool(
  'set_report_scope',
  {
    description: 'Change what a report you hold touches (areas, file globs, migration slot, branch), or clear it with an empty scope. Warns about overlapping claims.',
    inputSchema: { id: z.string(), scope: scopeArg },
  },
  async ({ id, scope }) => {
    const r = await client.setScope(id, scope && Object.keys(scope).length ? scope : null);
    return text(r.warning ?? 'Scope saved. No other active claim overlaps it.');
  },
);

server.registerTool(
  'list_conflicts',
  { description: 'Active claims whose work areas overlap, and whether the queue is free (nothing claimed or in review), e.g. before merging or migrating.' },
  async () => {
    const c = await client.conflicts();
    const lines = c.conflicts.map((x) => `#${x.a.id.slice(0, 8)} (${x.a.claimedBy ?? '?'}) ↔ #${otherSide(x, x.a.id).id.slice(0, 8)} (${x.b.claimedBy ?? '?'}): ${describeOverlaps(x.overlaps)}`);
    const head = c.free ? 'The queue is free: nothing is claimed or in review.' : `${c.active} active claim${c.active === 1 ? '' : 's'}.`;
    return text([head, ...(lines.length ? lines : c.free ? [] : ['No overlaps.'])].join('\n'));
  },
);

server.registerTool(
  'release_report',
  { description: 'Give a claimed report back to the queue.', inputSchema: { id: z.string() } },
  async ({ id }) => text(await client.release(id)),
);

server.registerTool(
  'close_report',
  {
    description: 'Close a report as fixed or wontfix. Put what you did or the reason in resolution, and the PR in pr_url.',
    inputSchema: { id: z.string(), status: z.enum(['fixed', 'wontfix']), resolution: z.string().optional(), pr_url: z.string().optional() },
  },
  async ({ id, status, resolution, pr_url }) => text(await client.close(id, status, resolution, pr_url)),
);

server.registerTool(
  'submit_for_review',
  {
    description: 'You opened a PR for a report you hold: it moves to In review with the link, and no longer needs heartbeats. Close it once merged.',
    inputSchema: { id: z.string(), pr_url: z.string() },
  },
  async ({ id, pr_url }) => text(await client.review(id, pr_url)),
);

server.registerTool(
  'heartbeat_report',
  { description: 'Tell the queue you are still working on a report you hold, so your claim does not run out.', inputSchema: { id: z.string() } },
  async ({ id }) => {
    const r = await client.heartbeat(id);
    return text(r.leaseExpiresAt ? `Still yours until ${r.leaseExpiresAt}.` : 'Still yours.');
  },
);

server.registerTool(
  'add_note',
  {
    description:
      "Add a note to a report's history that the team sees in the CueLog: what you found, what is missing, why you released it. Does not change the report.",
    inputSchema: { id: z.string(), text: z.string() },
  },
  async ({ id, text: note }) => {
    await client.note(id, note);
    return text('Noted.');
  },
);

server.registerTool(
  'merge_report',
  {
    description:
      "Close a report as a duplicate of another (into): it closes as won't fix with \"Duplicate of #<id>\", and both get a note in the CueLog.",
    inputSchema: { id: z.string(), into: z.string() },
  },
  async ({ id, into }) => {
    const r = await client.merge(id, into);
    return text(`Closed: ${r.resolution}.`);
  },
);

server.registerTool(
  'list_my_reports',
  { description: 'Reports you hold or that someone assigned to you.' },
  async () => {
    const reports = await client.mine();
    return text(
      reports.length
        ? reports.map((r) => `${r.id}  ${r.status} [${r.priority}] ${r.type} · ${r.description.split('\n')[0]?.slice(0, 80)}`).join('\n')
        : 'Nothing is assigned to you.',
    );
  },
);

await server.connect(new StdioServerTransport());
