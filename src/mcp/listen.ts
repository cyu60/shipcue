#!/usr/bin/env node
// Listen to a shipcue queue and act on what happens (shipcue report 8c11cf21).
//   SHIPCUE_URL=https://app.example.com/api/shipcue SHIPCUE_TOKEN=... npx shipcue-listen
//     prints one JSON line per event
//   npx shipcue-listen --on filed -- claude -p "Fix the newest report in the shipcue queue"
//     runs the command per event, with the event as JSON on stdin and SHIPCUE_EVENT,
//     SHIPCUE_REPORT_ID in its environment
// Options: --on filed,assigned,claimed,released,closed,video (default filed; assigned: queued
// for this agent in the CueLog), --every <seconds>
// (default 15), --backlog (treat reports already open as just filed), --once (one look, then
// exit; with --backlog, act on what is open now).

import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import type { Report } from '../core';
import { createAgentClient } from './client';
import { diffReports, LISTEN_EVENTS, type Change, type ListenEvent } from './events';

const url = process.env.SHIPCUE_URL;
const token = process.env.SHIPCUE_TOKEN;
if (!url || !token) {
  console.error('shipcue-listen: set SHIPCUE_URL and SHIPCUE_TOKEN');
  process.exit(1);
}

const args = process.argv.slice(2);
const dash = args.indexOf('--');
const flags = dash === -1 ? args : args.slice(0, dash);
const command = dash === -1 ? [] : args.slice(dash + 1);
const flag = (name: string) => {
  const i = flags.indexOf(name);
  return i === -1 ? undefined : flags[i + 1];
};
const on = new Set((flag('--on') ?? 'filed').split(',').map((s) => s.trim()) as ListenEvent[]);
for (const e of on) {
  if (!LISTEN_EVENTS.includes(e)) {
    console.error(`shipcue-listen: unknown event "${e}" (use ${LISTEN_EVENTS.join(', ')})`);
    process.exit(1);
  }
}
const everyMs = Math.max(5, Number(flag('--every') ?? 15)) * 1000;
const once = flags.includes('--once');
const backlog = flags.includes('--backlog');

const client = createAgentClient({ url, token, agent: process.env.SHIPCUE_AGENT ?? `listen@${hostname()}` });

// Inline screenshots can be megabytes; the event says where to get them instead.
function slim(change: Change): Change {
  const screenshots = change.report.screenshots.map((src, i) =>
    src.startsWith('data:') ? `(screenshot ${i + 1}: in GET ${url!.replace(/\/$/, '')}/reports/${change.report.id})` : src,
  );
  return { ...change, report: { ...change.report, screenshots } };
}

function run(change: Change): Promise<void> {
  const line = JSON.stringify({ ...slim(change), at: new Date().toISOString() });
  if (!command.length) {
    console.log(line);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const child = spawn(command[0]!, command.slice(1), {
      stdio: ['pipe', 'inherit', 'inherit'],
      env: { ...process.env, SHIPCUE_EVENT: change.type, SHIPCUE_REPORT_ID: change.report.id },
    });
    child.on('error', (err) => {
      console.error(`shipcue-listen: could not run ${command[0]}: ${err.message}`);
      resolve();
    });
    child.on('close', () => resolve());
    child.stdin.end(line);
  });
}

let seen: Map<string, Report> | null = null;

async function tick(): Promise<void> {
  try {
    const now = await client.list();
    if (seen === null && !backlog) {
      seen = new Map(now.map((r) => [r.id, r]));
      console.error(`shipcue-listen: watching ${now.length} reports for ${[...on].join(', ')}`);
      return;
    }
    // --backlog: only the open ones count as just filed, not the fixed history.
    const before = seen ?? new Map(now.filter((r) => r.status !== 'open' && r.status !== 'claimed').map((r) => [r.id, r]));
    let changes = diffReports(before, now).filter((c) => on.has(c.type.slice('report.'.length) as ListenEvent));
    // Only what was queued for this agent, not for another one.
    if (changes.some((c) => c.type === 'report.assigned')) {
      const mine = new Set((await client.mine()).map((r) => r.id));
      changes = changes.filter((c) => c.type !== 'report.assigned' || mine.has(c.report.id));
    }
    seen = new Map(now.map((r) => [r.id, r]));
    // One at a time, in order: an agent working on one report is not handed the next mid-run.
    for (const c of changes) await run(c);
  } catch (err) {
    console.error(`shipcue-listen: ${err instanceof Error ? err.message : err}; trying again`);
  }
}

await tick();
if (once) process.exit(0);
for (;;) {
  await new Promise((r) => setTimeout(r, everyMs));
  await tick();
}
