// `shipcue runner`: works a shipcue Cloud project's workflow steps on this machine. It pulls one
// job at a time per free slot (--capacity, default 1, so a Mac mini never runs fifty agents at
// once), runs it in its own git worktree, streams the log, heartbeats, and reports the result.
// Cloud decides what runs next; the runner only executes what it is handed.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { agentCommand, agentPrompt } from './agents';
import type { CompleteBody, Job, RunnerInfo, WorkflowClient } from './client';

export const POLL_MS = 5_000;
export const IDLE_MAX_MS = 30_000;
export const LOG_FLUSH_MS = 2_000;
const LOG_CHUNK = 32 * 1024;
// What a step prints is kept for ::output; the log itself is streamed, not kept.
const STDOUT_KEEP = 1024 * 1024;

export interface RunnerOptions {
  client: WorkflowClient;
  info: RunnerInfo;
  /** The git checkout each job's worktree is made from (a plain folder works too: jobs get an empty one). */
  repoDir: string;
  /** Where job folders go: <workDir>/<run>/<step>-<attempt>. */
  workDir: string;
  /** Take one job (or none), run it, and exit: a sandbox's runner. */
  once?: boolean;
  /** Extra flags for the agent CLIs, e.g. { claude: ['--permission-mode', 'acceptEdits'] }. */
  agentArgs?: { claude?: string[]; codex?: string[] };
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  pollMs?: number;
  idleMaxMs?: number;
  logFlushMs?: number;
}

export interface JobResult {
  status: 'succeeded' | 'failed' | 'cancelled' | 'released';
  output?: unknown;
  exitCode?: number | null;
  error?: string;
  /** Already sent to Cloud (an agent step reports as it goes, for the schema retry). */
  reported?: boolean;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });

/** What this machine offers: os:<platform>, claude and codex when installed, repo:<name> from the checkout's origin. */
export function detectLabels(repoDir: string, has: (cmd: string) => boolean = onPath): string[] {
  const labels = [`os:${process.platform}`];
  for (const cli of ['claude', 'codex']) if (has(cli)) labels.push(cli);
  const remote = spawnSync('git', ['-C', repoDir, 'remote', 'get-url', 'origin'], { encoding: 'utf8' });
  if (remote.status === 0 && remote.stdout.trim()) labels.push(`repo:${basename(remote.stdout.trim()).replace(/\.git$/, '')}`);
  return labels;
}

export function onPath(cmd: string): boolean {
  return spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' }).status === 0;
}

/** The env a step runs with: the runner's, minus its token, plus the step's env and SHIPCUE_* about the job. */
export function jobEnv(job: Job, base: NodeJS.ProcessEnv, outputFile: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  // A step is the team's code, not the runner's: it does not get the runner's token.
  delete env.SHIPCUE_TOKEN;
  for (const [k, v] of Object.entries(job.inputs ?? {})) env[`SHIPCUE_INPUT_${k.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`] = typeof v === 'string' ? v : JSON.stringify(v);
  return {
    ...env,
    ...job.env,
    SHIPCUE_RUN_ID: job.runId,
    SHIPCUE_WORKFLOW: job.workflow,
    SHIPCUE_STEP: job.step,
    SHIPCUE_ATTEMPT: String(job.attempt),
    SHIPCUE_OUTPUT_FILE: outputFile,
  };
}

/** A shell step's output: the JSON in SHIPCUE_OUTPUT_FILE, else the last `::output {json}` line it printed. */
export function shellOutput(stdout: string, fileText: string | null): unknown {
  if (fileText !== null && fileText.trim()) return JSON.parse(fileText);
  const lines = stdout.split('\n').filter((l) => l.startsWith('::output '));
  const last = lines.at(-1);
  return last ? JSON.parse(last.slice('::output '.length)) : null;
}

/** A job's folder: a detached git worktree of repoDir when it is a checkout, else an empty folder. */
function prepareWorkspace(repoDir: string, dir: string): { dir: string; worktree: boolean } {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, '..'), { recursive: true });
  const isGit = spawnSync('git', ['-C', repoDir, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' }).stdout.trim() === 'true';
  if (isGit && spawnSync('git', ['-C', repoDir, 'worktree', 'add', '--detach', dir, 'HEAD'], { stdio: 'ignore' }).status === 0) return { dir, worktree: true };
  mkdirSync(dir, { recursive: true });
  return { dir, worktree: false };
}

function removeWorkspace(repoDir: string, ws: { dir: string; worktree: boolean }) {
  if (ws.worktree) spawnSync('git', ['-C', repoDir, 'worktree', 'remove', '--force', ws.dir], { stdio: 'ignore' });
  rmSync(ws.dir, { recursive: true, force: true });
}

/** Batches a job's output into numbered chunks, sent every logFlushMs. */
function logStream(client: WorkflowClient, jobId: string, flushMs: number) {
  let seq = 0;
  let buf = '';
  let sending = Promise.resolve();
  const flush = () => {
    while (buf.length) {
      const chunk = buf.slice(0, LOG_CHUNK);
      buf = buf.slice(LOG_CHUNK);
      const n = seq++;
      sending = sending.then(() => client.log(jobId, n, chunk).then(() => undefined, () => undefined));
    }
    return sending;
  };
  const timer = setInterval(flush, flushMs);
  return {
    write: (s: string) => {
      buf += s;
    },
    async close() {
      clearInterval(timer);
      await flush();
    },
  };
}

/** Runs a process in its own group (so a timeout or a cancel stops everything it started). */
function runProcess(
  cmd: string,
  args: string[],
  o: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal: AbortSignal; onOutput: (s: string) => void },
): Promise<{ code: number | null; stdout: string; timedOut: boolean; error?: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let timedOut = false;
    const child = spawn(cmd, args, { cwd: o.cwd, env: o.env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const kill = () => {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
        else child.kill('SIGTERM');
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, o.timeoutMs);
    o.signal.addEventListener('abort', kill);
    child.stdout.on('data', (d: Buffer) => {
      const s = d.toString();
      stdout = (stdout + s).slice(-STDOUT_KEEP);
      o.onOutput(s);
    });
    child.stderr.on('data', (d: Buffer) => o.onOutput(d.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, timedOut, error: `could not run ${cmd}: ${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      o.signal.removeEventListener('abort', kill);
      resolve({ code, stdout, timedOut });
    });
  });
}

/**
 * Runs one job end to end: workspace, heartbeat, log, the step itself, and the result. `stop`
 * aborts it for a shutdown (the job is released for another runner); a heartbeat answered with
 * "no longer yours" aborts it as cancelled (nothing is reported).
 */
export async function runJob(job: Job, o: RunnerOptions, stop: AbortSignal = new AbortController().signal): Promise<JobResult> {
  const { client } = o;
  const say = o.log ?? (() => {});
  const ctl = new AbortController();
  let cancelled = false;
  const onStop = () => ctl.abort();
  stop.addEventListener('abort', onStop);
  const ws = prepareWorkspace(o.repoDir, join(o.workDir, job.runId, `${job.step}-${job.attempt}`));
  const meta = join(o.workDir, job.runId, `.${job.step}-${job.attempt}`);
  mkdirSync(meta, { recursive: true });
  const outputFile = join(meta, 'output.json');
  const log = logStream(client, job.id, o.logFlushMs ?? LOG_FLUSH_MS);
  const beat = setInterval(async () => {
    try {
      if (!(await client.heartbeat(job.id))) {
        cancelled = true;
        ctl.abort();
      }
    } catch {
      // A blip: the lease outlasts a few missed beats.
    }
  }, Math.max(1, job.heartbeatSeconds) * 1000);
  say(`${job.workflow}/${job.step} (run ${job.runId.slice(0, 8)}, attempt ${job.attempt}): started in ${ws.dir}`);
  try {
    await client.heartbeat(job.id);
    const env = jobEnv(job, o.env ?? process.env, outputFile);
    const run = (cmd: string, args: string[]) =>
      runProcess(cmd, args, { cwd: ws.dir, env, timeoutMs: job.timeoutSeconds * 1000, signal: ctl.signal, onOutput: log.write });
    let result: JobResult;
    if (job.kind === 'shell') {
      const p = await run('sh', ['-c', job.run ?? '']);
      if (p.error) result = { status: 'failed', error: p.error };
      else if (p.timedOut) result = { status: 'failed', exitCode: p.code, error: `timed out after ${job.timeoutSeconds}s` };
      else {
        let output: unknown = null;
        let bad: string | undefined;
        try {
          output = shellOutput(p.stdout, existsSync(outputFile) ? readFileSync(outputFile, 'utf8') : null);
        } catch (err) {
          bad = `its ::output was not JSON: ${err instanceof Error ? err.message : err}`;
        }
        result = p.code === 0 && !bad ? { status: 'succeeded', exitCode: 0, output } : { status: 'failed', exitCode: p.code, output, error: bad ?? `exited with ${p.code}` };
      }
    } else {
      result = await runAgent(job, o, ws.dir, meta, run, log.write);
    }
    if (stop.aborted) result = { status: 'released' };
    else if (cancelled) result = { status: 'cancelled' };
    await log.close();
    if (result.status === 'released') await client.release(job.id).catch(() => {});
    else if (result.status !== 'cancelled' && !result.reported) {
      const answer = await client.complete(job.id, completeBody(job, result));
      if (!answer.ok) say(`${job.workflow}/${job.step}: Cloud said ${answer.error}`);
    }
    say(`${job.workflow}/${job.step}: ${result.status}${result.error ? ` (${result.error})` : ''}`);
    return result;
  } finally {
    clearInterval(beat);
    stop.removeEventListener('abort', onStop);
    await log.close();
    removeWorkspace(o.repoDir, ws);
    rmSync(meta, { recursive: true, force: true });
  }
}

const completeBody = (job: Job, r: JobResult): CompleteBody => ({
  status: r.status === 'succeeded' ? 'succeeded' : 'failed',
  attempt: job.attempt,
  exitCode: r.exitCode ?? null,
  output: r.output ?? null,
  ...(r.error ? { error: r.error } : {}),
});

/**
 * An agent step: ask, parse the answer, and report it. When Cloud finds the answer does not fit the
 * schema (422 retry), ask once more with what was wrong; Cloud fails the step on a second miss.
 */
async function runAgent(
  job: Job,
  o: RunnerOptions,
  cwd: string,
  meta: string,
  run: (cmd: string, args: string[]) => ReturnType<typeof runProcess>,
  write: (s: string) => void,
): Promise<JobResult> {
  const schemaFile = join(meta, 'schema.json');
  const answerFile = join(meta, 'answer.txt');
  if (job.output) writeFileSync(schemaFile, JSON.stringify(job.output));
  let retryErrors: string[] = [];
  for (let ask = 0; ask < 2; ask++) {
    rmSync(answerFile, { force: true });
    const agent = job.agent ?? 'claude';
    const c = agentCommand(agent, {
      prompt: agentPrompt(job.prompt ?? '', job.output, retryErrors),
      schema: job.output,
      cwd,
      schemaFile,
      answerFile,
      extra: o.agentArgs?.[agent] ?? [],
    });
    write(`$ ${c.cmd} ${agent === 'claude' ? '-p …' : 'exec …'}\n`);
    const p = await run(c.cmd, c.args);
    if (p.error) return { status: 'failed', error: p.error };
    if (p.timedOut) return { status: 'failed', exitCode: p.code, error: `timed out after ${job.timeoutSeconds}s` };
    if (p.code !== 0) return { status: 'failed', exitCode: p.code, error: `${c.cmd} exited with ${p.code}` };
    let output: unknown;
    try {
      output = c.parse(p.stdout, (f) => (existsSync(f) ? readFileSync(f, 'utf8') : null));
    } catch (err) {
      return { status: 'failed', exitCode: 0, error: err instanceof Error ? err.message : String(err) };
    }
    const answer = await o.client.complete(job.id, { status: 'succeeded', attempt: job.attempt, exitCode: 0, output });
    if (answer.ok) return { status: 'succeeded', exitCode: 0, output, reported: true };
    if (answer.retry && ask === 0) {
      write(`the answer did not fit the schema (${answer.errors.join('; ')}); asking again\n`);
      retryErrors = answer.errors;
      continue;
    }
    return { status: 'failed', output, error: answer.error, reported: true };
  }
  return { status: 'failed', error: 'no answer', reported: true };
}

/**
 * The loop: claim while there is a free slot, back off from pollMs to idleMaxMs while idle, and on
 * stop() release every job it holds so another runner takes them.
 */
export function startRunner(o: RunnerOptions): { stop: () => Promise<void>; done: Promise<void> } {
  const stopper = new AbortController();
  const active = new Map<string, Promise<JobResult>>();
  const say = o.log ?? (() => {});
  const poll = o.pollMs ?? POLL_MS;
  const idleMax = o.idleMaxMs ?? IDLE_MAX_MS;
  let wake: AbortController = new AbortController();
  const done = (async () => {
    let idle = poll;
    while (!stopper.signal.aborted) {
      if (active.size < o.info.capacity) {
        let job: Job | null = null;
        try {
          job = await o.client.claim(o.info);
        } catch (err) {
          say(`claim failed: ${err instanceof Error ? err.message : err}; trying again`);
        }
        if (job) {
          idle = poll;
          const id = job.id;
          const p = runJob(job, o, stopper.signal)
            .catch((err): JobResult => {
              say(`${job!.step}: ${err instanceof Error ? err.message : err}`);
              return { status: 'failed', error: String(err) };
            })
            .finally(() => {
              active.delete(id);
              wake.abort();
            });
          active.set(id, p);
          if (o.once) {
            await p;
            break;
          }
          continue;
        }
        if (o.once) break;
      }
      await sleep(idle, AbortSignal.any([stopper.signal, wake.signal]));
      wake = new AbortController();
      if (active.size === 0) idle = Math.min(idleMax, idle * 2);
    }
    await Promise.all(active.values());
  })();
  return {
    async stop() {
      stopper.abort();
      await done;
    },
    done,
  };
}
