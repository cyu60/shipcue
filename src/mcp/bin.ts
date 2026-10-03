#!/usr/bin/env node
// MCP server so Claude Code, Codex or any MCP client can work the queue.
//   claude mcp add shipcue -e SHIPCUE_URL=https://app.example.com/api/shipcue -e SHIPCUE_TOKEN=... -- npx shipcue-mcp

import { hostname } from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createAgentClient } from './client';

const url = process.env.SHIPCUE_URL;
const token = process.env.SHIPCUE_TOKEN;
if (!url || !token) {
  console.error('shipcue-mcp: set SHIPCUE_URL and SHIPCUE_TOKEN');
  process.exit(1);
}

const client = createAgentClient({ url, token, agent: process.env.SHIPCUE_AGENT ?? `mcp@${hostname()}` });
const server = new McpServer({ name: 'shipcue', version: '0.13.0' });

const text = (value: unknown) => ({
  content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});

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
      'Take the next report: one assigned to you first, then the most urgent open one. Returns a task prompt with the page, screenshots and app snapshot. If the queue gives claims a lease, call heartbeat_report while you work.',
  },
  async () => {
    const claimed = await client.claimNext();
    return text(claimed ? claimed.prompt : 'Nothing open. The queue is empty.');
  },
);

server.registerTool(
  'get_report',
  { description: 'Read one report as a task prompt.', inputSchema: { id: z.string() } },
  async ({ id }) => text((await client.get(id)).prompt),
);

server.registerTool(
  'claim_report',
  { description: 'Take a specific open report.', inputSchema: { id: z.string() } },
  async ({ id }) => text((await client.claim(id)).prompt),
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
