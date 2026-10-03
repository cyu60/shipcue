#!/usr/bin/env node
// shipcue's setup CLI (shipcue report 5fdbd60f).
//   npx shipcue doctor [--url https://app/api/shipcue] [--route <file>] [--env A,B] [--offline] [--db | --no-db]
//   npx shipcue init --cloud <pk_…> [--write]

import { readFileSync } from 'node:fs';
import { runDoctor } from './doctor';
import { runInit } from './init';

const [command, ...args] = process.argv.slice(2);
const HELP = `shipcue doctor   check this app's shipcue setup and print the fix for each ✗
  --url <https://app/api/shipcue>  also check the live endpoint, the agent API and the tables
  --route <file>                   where the handler is mounted (default: the Next.js route)
  --env A,B                        the env vars to look for (default: what the route reads)
  --db / --no-db                   check the tables without --url / skip them
  --offline                        don't look up the newest release
shipcue init --cloud <pk_…>      the button for a shipcue Cloud project (--write adds it)
`;

async function main() {
  if (command === 'doctor') {
    // dist/cli/bin.js → the package's own sql/schema.sql, so it matches the installed version.
    const schemaSql = readFileSync(new URL('../../sql/schema.sql', import.meta.url), 'utf8');
    return runDoctor({ cwd: process.cwd(), args, schemaSql });
  }
  if (command === 'init') return runInit({ cwd: process.cwd(), args });
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
