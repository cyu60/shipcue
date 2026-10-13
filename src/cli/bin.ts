#!/usr/bin/env node
// shipcue's setup CLI (shipcue report 5fdbd60f).
//   npx shipcue doctor [--url https://app/api/shipcue] [--route <file>] [--env A,B] [--offline] [--db | --no-db]
//   npx shipcue init --cloud <pk_…> [--write]
//   npx shipcue workflows init|push|list, run <name>, runner [install] (shipcue Cloud Workflows, ./workflows.ts)

import { readFileSync } from 'node:fs';
import { runDoctor } from './doctor';
import { runInit } from './init';
import { workflowsCli } from './workflows';

const [command, ...args] = process.argv.slice(2);
const HELP = `shipcue doctor   check this app's shipcue setup and print the fix for each ✗
  --url <https://app/api/shipcue>  also check the live endpoint, the agent API and the tables
  --route <file>                   where the handler is mounted (default: the Next.js route)
  --env A,B                        the env vars to look for (default: what the route reads)
  --db / --no-db                   check the tables without --url / skip them
  --offline                        don't look up the newest release
shipcue init --cloud <pk_…>      the button for a shipcue Cloud project (--write adds it)

shipcue Cloud Workflows (SHIPCUE_URL = the project endpoint …/api/cloud/p/<pk_…>, SHIPCUE_TOKEN = an agent token):
shipcue workflows init           write .shipcue/workflows/fix-report.yml and scripts/ship-gates.sh (--force replaces)
shipcue workflows push           check every .shipcue/workflows file with Cloud, then save them all
shipcue workflows list
shipcue run <workflow> [--input name=value ...] [--no-follow]   start a run and follow it
shipcue runner                   work this project's steps here until stopped
  --capacity <n>                   jobs at a time (default 1)
  --repo <dir>                     the checkout jobs get worktrees of (default .)
  --name <name> --labels a,b       how it shows in the app; labels on top of os:, claude, codex, repo:
  --claude-args "…" --codex-args "…"  extra agent CLI flags, e.g. --claude-args "--permission-mode acceptEdits"
  --once                           take one job (or none), run it, exit
shipcue runner install [--print] the runner as a launchd (macOS) or systemd (Linux) service, same flags
`;

async function main() {
  if (command === 'doctor') {
    // dist/cli/bin.js → the package's own sql/schema.sql, so it matches the installed version.
    const schemaSql = readFileSync(new URL('../../sql/schema.sql', import.meta.url), 'utf8');
    return runDoctor({ cwd: process.cwd(), args, schemaSql });
  }
  if (command === 'init') return runInit({ cwd: process.cwd(), args });
  if (command === 'workflows' || command === 'run' || command === 'runner') return workflowsCli(command, { cwd: process.cwd(), args, env: process.env });
  return { output: HELP, code: command === undefined || command === '--help' || command === 'help' ? 0 : 1 };
}

main().then(
  ({ output, code }) => {
    process.stdout.write(output);
    process.exit(code);
  },
  (err) => {
    console.error(`shipcue: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  },
);
