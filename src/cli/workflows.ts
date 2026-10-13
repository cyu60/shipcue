// shipcue Workflows from the command line (shipcue Cloud):
//   npx shipcue workflows init        write .shipcue/workflows/fix-report.yml and scripts/ship-gates.sh
//   npx shipcue workflows push        check every .shipcue/workflows/*.yml with Cloud, then save them
//   npx shipcue workflows list
//   npx shipcue run <name> --input report_id=…   start a run and follow it
//   npx shipcue runner [--capacity 1]            work this project's steps on this machine
//   npx shipcue runner install [--print]         keep the runner up as a launchd / systemd service
// SHIPCUE_URL (the project endpoint, …/api/cloud/p/<pk_…>) and SHIPCUE_TOKEN (an agent token) come
// from the environment, or --url and --token.

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { SHIPCUE_VERSION } from '../core';
import { CloudError, createWorkflowClient, RUN_DONE, runPageUrl, type RunDetail, type WorkflowClient } from '../runner/client';
import { detectLabels, startRunner } from '../runner/runner';
import { serviceFiles, shq, slug, type ServiceSpec } from '../runner/service';
import { fixReportWorkflow, SHIP_GATES } from '../runner/templates';
import { flagValue } from './doctor';

export const WORKFLOW_DIR = '.shipcue/workflows';
/** The prebuilt release a service runs (shipcue is not on npm yet). */
export const releaseTarball = (version: string) => `https://github.com/edumame/shipcue/releases/download/v${version}/shipcue-${version}.tgz`;

export interface CliContext {
  cwd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  out?: (s: string) => void;
  sleep?: (ms: number) => Promise<void>;
}
type Result = { output: string; code: number };

/** Every --name value, for flags given more than once (--input a=1 --input b=2). */
const flagValues = (args: string[], name: string) => args.flatMap((a, i) => (a === name && args[i + 1] !== undefined ? [args[i + 1]!] : []));
const words = (s: string | undefined) => (s ? s.split(/\s+/).filter(Boolean) : []);

function connection(c: CliContext): { url: string; token: string } | string {
  const url = flagValue(c.args, '--url') ?? c.env.SHIPCUE_URL;
  const token = flagValue(c.args, '--token') ?? c.env.SHIPCUE_TOKEN;
  if (!url || !token) return 'Set SHIPCUE_URL (your project endpoint, …/api/cloud/p/<pk_…>) and SHIPCUE_TOKEN (an agent token from Setup), or pass --url and --token.\n';
  if (!/\/p\/pk_[0-9a-f]+\/?$/.test(url)) return `SHIPCUE_URL should be a shipcue Cloud project endpoint ending in /api/cloud/p/<pk_…>; got ${url}\n`;
  return { url: url.replace(/\/+$/, ''), token };
}

const repoName = (dir: string) => {
  const r = spawnSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() ? basename(r.stdout.trim()).replace(/\.git$/, '') : null;
};

export function workflowsInit(c: CliContext): Result {
  const force = c.args.includes('--force');
  const files: [string, string, number][] = [
    [join(WORKFLOW_DIR, 'fix-report.yml'), fixReportWorkflow(repoName(c.cwd)), 0o644],
    ['scripts/ship-gates.sh', SHIP_GATES, 0o755],
  ];
  let out = '';
  for (const [rel, text, mode] of files) {
    const path = join(c.cwd, rel);
    if (existsSync(path) && !force) {
      out += `${rel} already exists; left as it is (--force replaces it)\n`;
      continue;
    }
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
    chmodSync(path, mode);
    out += `wrote ${rel}\n`;
  }
  return { output: `${out}\nNext: read them, then \`npx shipcue workflows push\` and \`npx shipcue runner install\`.\n`, code: 0 };
}

/** Checks every file with Cloud first (dry run); saves them only when all of them are good. */
export async function workflowsPush(c: CliContext, client: WorkflowClient): Promise<Result> {
  const dir = resolve(c.cwd, flagValue(c.args, '--dir') ?? WORKFLOW_DIR);
  if (!existsSync(dir)) return { output: `No ${WORKFLOW_DIR} here. Run \`npx shipcue workflows init\` first.\n`, code: 1 };
  const files = readdirSync(dir).filter((f) => /\.(ya?ml|json)$/.test(f)).sort();
  if (!files.length) return { output: `No workflow files in ${dir}.\n`, code: 1 };
  const sources = files.map((f) => ({ file: f, source: readFileSync(join(dir, f), 'utf8') }));
  let out = '';
  let bad = 0;
  for (const s of sources) {
    try {
      const r = await client.push(s.source, true);
      const stem = s.file.replace(/\.(ya?ml|json)$/, '');
      if (r.workflow.name !== stem) out += `${s.file}: note: the workflow is named ${r.workflow.name}\n`;
    } catch (err) {
      bad++;
      const errors = err instanceof CloudError ? ((err.body.errors as string[] | undefined) ?? [err.message]) : [String(err)];
      out += `${s.file}:\n${errors.map((e) => `  ✗ ${e}`).join('\n')}\n`;
    }
  }
  if (bad) return { output: `${out}Nothing pushed: fix ${bad === 1 ? 'that file' : 'those files'} first.\n`, code: 1 };
  for (const s of sources) {
    const r = await client.push(s.source);
    out += `${r.created ? 'pushed' : 'unchanged'} ${r.workflow.name} (${r.version?.sha.slice(0, 12)})\n`;
  }
  return { output: out, code: 0 };
}

export async function workflowsList(client: WorkflowClient): Promise<Result> {
  const list = await client.listWorkflows();
  if (!list.length) return { output: 'No workflows yet. `npx shipcue workflows init` writes one.\n', code: 0 };
  const lines = list.map((w) => {
    const on = [w.on.manual ? 'manual' : null, w.on.report.length ? `report ${w.on.report.join(',')}` : null, w.on.schedule ? `schedule ${w.on.schedule}` : null].filter(Boolean).join('; ');
    return `${w.name}  ${w.steps.length} steps  ${w.approval === 'required' ? 'needs approval  ' : ''}on: ${on}`;
  });
  return { output: `${lines.join('\n')}\n`, code: 0 };
}

const stepLine = (s: RunDetail['steps'][number]) =>
  `  ${s.key}: ${s.status}${s.attempt > 1 ? ` (attempt ${s.attempt})` : ''}${s.runner ? ` on ${s.runner}` : ''}${s.error ? ` — ${s.error}` : ''}${s.question && s.status === 'waiting_approval' ? ` — "${s.question}"` : ''}`;

/** Starts a run and, unless --no-follow, prints each step's moves and log until it finishes. */
export async function runCommand(c: CliContext, client: WorkflowClient, url: string): Promise<Result> {
  const name = c.args.find((a, i) => !a.startsWith('--') && !['--input', '--url', '--token'].includes(c.args[i - 1] ?? ''));
  if (!name) return { output: 'usage: npx shipcue run <workflow> [--input name=value ...] [--no-follow]\n', code: 1 };
  const inputs: Record<string, string> = {};
  for (const kv of flagValues(c.args, '--input')) {
    const i = kv.indexOf('=');
    if (i < 1) return { output: `--input is name=value; got ${kv}\n`, code: 1 };
    inputs[kv.slice(0, i)] = kv.slice(i + 1);
  }
  const out = c.out ?? ((s: string) => process.stdout.write(s));
  const sleep = c.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let detail: RunDetail;
  try {
    detail = await client.startRun(name, inputs);
  } catch (err) {
    const errors = err instanceof CloudError ? ((err.body.errors as string[] | undefined) ?? []) : [];
    return { output: `${err instanceof Error ? err.message : err}\n${errors.map((e) => `  ✗ ${e}`).join('\n')}${errors.length ? '\n' : ''}`, code: 1 };
  }
  const id = detail.run.id;
  out(`run ${id} (${name}): ${detail.run.status}\n  ${runPageUrl(url, detail)}\n`);
  if (c.args.includes('--no-follow')) return { output: '', code: 0 };
  const seen = new Map<string, string>();
  const logSeq = new Map<string, number>();
  let lastRun = '';
  for (;;) {
    if (detail.run.status !== lastRun) {
      lastRun = detail.run.status;
      if (lastRun === 'awaiting_approval') out(`waiting for a person to approve the run in the app\n`);
    }
    for (const s of detail.steps) {
      const line = stepLine(s);
      if (seen.get(s.key) !== line) {
        seen.set(s.key, line);
        if (s.status !== 'blocked') out(`${line}\n`);
      }
      if (['claimed', 'running', 'succeeded', 'failed'].includes(s.status) && s.lastSeq !== null && s.lastSeq > (logSeq.get(s.key) ?? -1)) {
        for (const chunk of await client.stepLog(id, s.key, logSeq.get(s.key) ?? -1)) {
          out(chunk.chunk.replace(/^/gm, `    ${s.key} | `).replace(/ \| $/, ''));
          logSeq.set(s.key, chunk.seq);
        }
      }
    }
    if (RUN_DONE.includes(detail.run.status)) return { output: `run ${id}: ${detail.run.status}\n`, code: detail.run.status === 'succeeded' ? 0 : 1 };
    await sleep(2000);
    detail = await client.getRun(id);
  }
}

/** The runner's settings from flags and env. */
function runnerSettings(c: CliContext) {
  const repoDir = resolve(c.cwd, flagValue(c.args, '--repo') ?? '.');
  const capacity = Math.max(1, Math.min(32, Number(flagValue(c.args, '--capacity') ?? 1) || 1));
  const name = flagValue(c.args, '--name') ?? `${hostname().replace(/\.local$/, '')}`;
  const extra = (flagValue(c.args, '--labels') ?? '').split(',').map((l) => l.trim()).filter(Boolean);
  return {
    repoDir,
    capacity,
    name,
    extra,
    claudeArgs: words(flagValue(c.args, '--claude-args') ?? c.env.SHIPCUE_CLAUDE_ARGS),
    codexArgs: words(flagValue(c.args, '--codex-args') ?? c.env.SHIPCUE_CODEX_ARGS),
    workDir: flagValue(c.args, '--work-dir') ?? join(homedir(), '.shipcue', 'work'),
  };
}

/** `shipcue runner`: runs until SIGTERM / SIGINT, which hand held jobs back. */
export async function runnerCommand(c: CliContext, client: WorkflowClient): Promise<Result> {
  const s = runnerSettings(c);
  const labels = [...new Set([...detectLabels(s.repoDir), ...s.extra])];
  const once = c.args.includes('--once');
  const log = (line: string) => process.stderr.write(`shipcue runner: ${line}\n`);
  log(`${s.name} working ${s.repoDir} (labels ${labels.join(', ')}; up to ${s.capacity} at a time)`);
  const runner = startRunner({
    client,
    info: { name: s.name, labels, os: process.platform, version: SHIPCUE_VERSION, capacity: s.capacity },
    repoDir: s.repoDir,
    workDir: s.workDir,
    once,
    agentArgs: { claude: s.claudeArgs, codex: s.codexArgs },
    log,
  });
  const stop = () => {
    log('stopping: handing held jobs back');
    void runner.stop();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  await runner.done;
  return { output: '', code: 0 };
}

/** `shipcue runner install`: the runner as a service; --print shows the file instead of installing it. */
export function runnerInstall(c: CliContext, conn: { url: string; token: string }): Result {
  const s = runnerSettings(c);
  const flags = [
    '--name', s.name,
    '--capacity', String(s.capacity),
    '--repo', s.repoDir,
    ...(s.extra.length ? ['--labels', s.extra.join(',')] : []),
    ...(s.claudeArgs.length ? ['--claude-args', s.claudeArgs.join(' ')] : []),
    ...(s.codexArgs.length ? ['--codex-args', s.codexArgs.join(' ')] : []),
  ];
  const spec: ServiceSpec = {
    name: `runner-${slug(basename(s.repoDir))}`,
    description: `shipcue runner for ${basename(s.repoDir)}`,
    command: `npx -y -p ${releaseTarball(SHIPCUE_VERSION)} shipcue runner ${flags.map(shq).join(' ')}`,
    env: { SHIPCUE_URL: conn.url, SHIPCUE_TOKEN: conn.token },
    workingDirectory: s.repoDir,
  };
  const platform = (flagValue(c.args, '--platform') as NodeJS.Platform | undefined) ?? process.platform;
  if (platform !== 'darwin' && platform !== 'linux') return { output: 'runner install supports macOS (launchd) and Linux (systemd). Run `npx shipcue runner` under your own supervisor.\n', code: 1 };
  const home = c.env.HOME ?? homedir();
  const f = serviceFiles(spec, platform, home);
  if (c.args.includes('--print')) return { output: `# ${f.path} (mode 600: it holds the token)\n${f.text.replace(conn.token, '<SHIPCUE_TOKEN>')}`, code: 0 };
  mkdirSync(join(f.path, '..'), { recursive: true });
  writeFileSync(f.path, f.text, { mode: 0o600 });
  chmodSync(f.path, 0o600);
  for (const [cmd, ...args] of f.start) spawnSync(cmd!, args, { stdio: 'ignore' });
  return { output: `installed ${f.path}\nLogs: ${f.logs}\nStop: ${f.stop}\nIt shows up under Runners in the app once it claims.\n`, code: 0 };
}

/** The `workflows`, `run` and `runner` commands. */
export async function workflowsCli(command: 'workflows' | 'run' | 'runner', c: CliContext): Promise<Result> {
  const [sub] = c.args;
  if (command === 'workflows' && sub === 'init') return workflowsInit({ ...c, args: c.args.slice(1) });
  const conn = connection(c);
  if (typeof conn === 'string') return { output: conn, code: 1 };
  const client = createWorkflowClient({ ...conn, fetch: c.fetch });
  try {
    if (command === 'workflows' && sub === 'push') return await workflowsPush({ ...c, args: c.args.slice(1) }, client);
    if (command === 'workflows' && (sub === 'list' || sub === undefined)) return await workflowsList(client);
    if (command === 'run') return await runCommand(c, client, conn.url);
    if (command === 'runner' && sub === 'install') return runnerInstall({ ...c, args: c.args.slice(1) }, conn);
    if (command === 'runner') return await runnerCommand(c, client);
  } catch (err) {
    return { output: `${err instanceof Error ? err.message : err}\n`, code: 1 };
  }
  return { output: `unknown: shipcue ${command} ${sub ?? ''}\n`, code: 1 };
}
