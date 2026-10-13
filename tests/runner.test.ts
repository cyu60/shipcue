// `shipcue runner`, `workflows init/push`, `run` and the MCP workflow tools (shipcue Cloud Workflows),
// against a fake Cloud that speaks the runner protocol, and fake claude / codex binaries on PATH.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import { agentCommand, agentPrompt, answerFrom } from '../src/runner/agents';
import { createWorkflowClient, type Job } from '../src/runner/client';
import { jobEnv, runJob, shellOutput, startRunner, type RunnerOptions } from '../src/runner/runner';
import { launchdPlist, systemdUnit } from '../src/runner/service';
import { runCommand, runnerInstall, workflowsInit, workflowsPush, workflowsCli } from '../src/cli/workflows';
import { workflowTools } from '../src/mcp/workflow-tools';

const URL_ = 'https://cloud.example.com/api/cloud/p/pk_0123456789abcdef01234567';

/** Cloud's runner endpoints, in memory. Each answer can be scripted per test. */
function fakeCloud() {
  const calls: { method: string; path: string; body: any }[] = [];
  const state = {
    jobs: [] as Job[],
    logs: {} as Record<string, string>,
    completes: [] as { id: string; body: any }[],
    released: [] as string[],
    heartbeatOk: true,
    completeAnswers: [] as { status: number; body: any }[],
    pushAnswers: {} as Record<string, { status: number; body: any }>,
    runs: [] as any[],
  };
  const fetch = async (url: string, init?: RequestInit) => {
    const path = url.slice(URL_.length);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? 'GET', path, body });
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sca_test');
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    let m: RegExpMatchArray | null;
    if (path === '/runner/claim') {
      const job = state.jobs.shift();
      return job ? json({ job }) : new Response(null, { status: 204 });
    }
    if ((m = path.match(/^\/runner\/jobs\/([^/]+)\/(\w+)$/))) {
      const [, id, what] = m;
      if (what === 'heartbeat') return state.heartbeatOk ? json({ ok: true }) : json({ error: 'gone', cancel: true }, 409);
      if (what === 'log') {
        state.logs[id!] = (state.logs[id!] ?? '') + body.chunk;
        return json({ ok: true });
      }
      if (what === 'complete') {
        state.completes.push({ id: id!, body });
        const a = state.completeAnswers.shift();
        return a ? json(a.body, a.status) : json({ ok: true });
      }
      if (what === 'release') {
        state.released.push(id!);
        return json({ ok: true });
      }
    }
    if (path === '/workflows' && init?.method === 'POST') {
      const name = /name: (\S+)/.exec(body.source)?.[1] ?? '?';
      const scripted = state.pushAnswers[name];
      if (scripted) return json(scripted.body, scripted.status);
      return json(body.dryRun ? { ok: true, workflow: { name } } : { workflow: { name }, created: true, version: { sha: 'a'.repeat(64) } }, body.dryRun ? 200 : 201);
    }
    if ((m = path.match(/^\/workflows\/([^/]+)\/runs$/))) {
      const run = state.runs.shift();
      return run ? json(run) : json({ error: 'Those inputs do not fit the workflow.', errors: ['inputs.report_id: is required'] }, 422);
    }
    if ((m = path.match(/^\/runs\/([^/?]+)$/))) return json(state.runs.shift());
    if ((m = path.match(/^\/runs\/([^/]+)\/steps\/([^/]+)\/log/))) return json({ chunks: [{ seq: 0, chunk: 'built it\n' }] });
    if (path === '/workflows') return json({ workflows: [{ name: 'fix-report', description: null, approval: 'required', on: { manual: true, report: ['filed'], schedule: null }, inputs: { report_id: { type: 'string', required: true, default: null } }, steps: [{ key: 'claim', kind: 'builtin', needs: [] }, { key: 'build', kind: 'agent', needs: ['claim'] }] }] });
    return json({ error: 'Not found' }, 404);
  };
  return { calls, state, client: createWorkflowClient({ url: URL_, token: 'sca_test', fetch }), fetch };
}

let dir: string;
let bin: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shipcue-runner-'));
  bin = join(dir, 'bin');
  spawnSync('mkdir', ['-p', bin]);
});

/** A script on PATH standing in for claude or codex. */
function fakeBin(name: string, script: string) {
  const p = join(bin, name);
  writeFileSync(p, `#!/bin/sh\n${script}\n`);
  chmodSync(p, 0o755);
}

const job = (over: Partial<Job> = {}): Job => ({
  id: 'step-1',
  runId: 'run-1',
  workflow: 'fix-report',
  step: 'gates',
  attempt: 1,
  kind: 'shell',
  run: 'echo hi',
  agent: null,
  prompt: null,
  output: null,
  env: {},
  inputs: { report_id: 'r1' },
  timeoutSeconds: 30,
  leaseSeconds: 600,
  heartbeatSeconds: 30,
  ...over,
});

function options(cloud: ReturnType<typeof fakeCloud>, over: Partial<RunnerOptions> = {}): RunnerOptions {
  return {
    client: cloud.client,
    info: { name: 'mini', labels: ['claude'], os: 'darwin', version: 'test', capacity: 1 },
    repoDir: dir,
    workDir: join(dir, 'work'),
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SHIPCUE_TOKEN: 'sca_secret' },
    logFlushMs: 20,
    pollMs: 10,
    idleMaxMs: 20,
    ...over,
  };
}

describe('shell steps', () => {
  it('runs the command with the step env, streams its log and reports ::output', async () => {
    const cloud = fakeCloud();
    const r = await runJob(
      job({ run: 'echo "pr is $PR_URL for $SHIPCUE_INPUT_REPORT_ID at $SHIPCUE_STEP"; echo "token:${SHIPCUE_TOKEN:-none}"; echo \'::output {"head":"abc"}\'', env: { PR_URL: 'https://x/1' } }),
      options(cloud),
    );
    expect(r).toMatchObject({ status: 'succeeded', output: { head: 'abc' } });
    expect(cloud.state.completes).toEqual([{ id: 'step-1', body: { status: 'succeeded', attempt: 1, exitCode: 0, output: { head: 'abc' } } }]);
    expect(cloud.state.logs['step-1']).toContain('pr is https://x/1 for r1 at gates');
    // The runner's own token never reaches a step.
    expect(cloud.state.logs['step-1']).toContain('token:none');
    // Its folder is gone afterwards.
    expect(existsSync(join(dir, 'work', 'run-1', 'gates-1'))).toBe(false);
  });

  it('reports a failing exit code, and output written to SHIPCUE_OUTPUT_FILE', async () => {
    const cloud = fakeCloud();
    const r = await runJob(job({ run: 'echo \'{"why":"lint"}\' > "$SHIPCUE_OUTPUT_FILE"; exit 4' }), options(cloud));
    expect(r).toMatchObject({ status: 'failed', exitCode: 4, output: { why: 'lint' }, error: 'exited with 4' });
    expect(cloud.state.completes[0]!.body).toMatchObject({ status: 'failed', exitCode: 4 });
  });

  it('stops a step that runs past its timeout', async () => {
    const cloud = fakeCloud();
    const r = await runJob(job({ run: 'sleep 20', timeoutSeconds: 1 }), options(cloud));
    expect(r).toMatchObject({ status: 'failed', error: 'timed out after 1s' });
  });

  it('kills the step when Cloud says it is no longer this runner’s, and reports nothing', async () => {
    const cloud = fakeCloud();
    const started = Date.now();
    const pending = runJob(job({ run: 'sleep 20', heartbeatSeconds: 1 }), options(cloud));
    cloud.state.heartbeatOk = false;
    const r = await pending;
    expect(r.status).toBe('cancelled');
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(cloud.state.completes).toEqual([]);
  });
});

describe('agent steps', () => {
  const schema = { type: 'object', required: ['status'], properties: { status: { enum: ['pr_opened', 'blocked'] } } };

  it('runs claude with the prompt and schema, and asks once more when Cloud says the answer missed', async () => {
    // First answer misses; the second (asked with what was wrong) fits.
    fakeBin(
      'claude',
      `case "$2" in *"did not fit"*) echo '{"type":"result","result":"ok","structured_output":{"status":"pr_opened"}}';; *) echo '{"type":"result","result":"{\\"status\\":\\"done\\"}"}';; esac
echo "$@" >> "${bin}/claude.args"`,
    );
    const cloud = fakeCloud();
    cloud.state.completeAnswers.push({ status: 422, body: { error: 'does not match', errors: ['$.status: must be one of "pr_opened", "blocked"'], retry: true } });
    const r = await runJob(job({ kind: 'agent', agent: 'claude', run: null, prompt: 'Fix report r1', output: schema }), options(cloud, { agentArgs: { claude: ['--permission-mode', 'acceptEdits'] } }));
    expect(r).toMatchObject({ status: 'succeeded', output: { status: 'pr_opened' } });
    expect(cloud.state.completes.map((c) => c.body.output)).toEqual([{ status: 'done' }, { status: 'pr_opened' }]);
    const args = readFileSync(join(bin, 'claude.args'), 'utf8');
    expect(args).toContain('--output-format json --json-schema');
    expect(args).toContain('--permission-mode acceptEdits');
    expect(args).toContain('Fix report r1');
  });

  it('gives up after the second miss (Cloud fails the step)', async () => {
    fakeBin('claude', `echo '{"type":"result","result":"{}"}'`);
    const cloud = fakeCloud();
    cloud.state.completeAnswers.push({ status: 422, body: { error: 'miss', errors: ['$.status: is required'], retry: true } });
    cloud.state.completeAnswers.push({ status: 422, body: { error: 'The output did not match the schema again; the step failed.', errors: [], retry: false } });
    const r = await runJob(job({ kind: 'agent', agent: 'claude', run: null, prompt: 'x', output: schema }), options(cloud));
    expect(r.status).toBe('failed');
    expect(cloud.state.completes).toHaveLength(2);
  });

  it('runs codex exec with the schema file and reads its last message', async () => {
    fakeBin(
      'codex',
      `out=""; schema=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift;; --output-schema) schema="$2"; shift;; esac; shift; done
test -f "$schema" || exit 9
echo '{"verdict":"ready"}' > "$out"`,
    );
    const cloud = fakeCloud();
    const r = await runJob(job({ kind: 'agent', agent: 'codex', run: null, prompt: 'Review', output: { type: 'object', required: ['verdict'] } }), options(cloud));
    expect(r).toMatchObject({ status: 'succeeded', output: { verdict: 'ready' } });
  });

  it('fails the step when the agent CLI is missing or exits non-zero', async () => {
    fakeBin('claude', 'exit 2');
    const cloud = fakeCloud();
    expect(await runJob(job({ kind: 'agent', agent: 'claude', run: null, prompt: 'x' }), options(cloud))).toMatchObject({ status: 'failed', error: 'claude exited with 2' });
  });

  it('builds both CLIs’ commands in one place and finds JSON in a reply', () => {
    const c = agentCommand('codex', { prompt: 'p', schema: { type: 'object' }, cwd: '/w', schemaFile: '/m/s.json', answerFile: '/m/a.txt' });
    expect([c.cmd, ...c.args]).toEqual(['codex', 'exec', '--skip-git-repo-check', '-C', '/w', '--output-schema', '/m/s.json', '-o', '/m/a.txt', 'p']);
    expect(agentPrompt('Do it', { type: 'object' })).toContain('JSON Schema');
    expect(answerFrom('Done.\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(answerFrom('text then\n{"b":2}')).toEqual({ b: 2 });
    expect(() => answerFrom('no json')).toThrow();
  });
});

describe('the runner loop', () => {
  it('takes up to its capacity at once, then hands held jobs back on stop', async () => {
    const cloud = fakeCloud();
    cloud.state.jobs.push(job({ id: 'a', step: 'a', run: 'sleep 20' }), job({ id: 'b', step: 'b', run: 'sleep 20' }), job({ id: 'c', step: 'c', run: 'sleep 20' }));
    const o = options(cloud);
    const runner = startRunner({ ...o, info: { ...o.info, capacity: 2 } });
    await new Promise((r) => setTimeout(r, 400));
    expect(cloud.calls.filter((c) => c.path === '/runner/claim').length).toBeGreaterThanOrEqual(2);
    expect(cloud.state.jobs.map((j) => j.id)).toEqual(['c']);
    await runner.stop();
    expect(cloud.state.released.sort()).toEqual(['a', 'b']);
    expect(cloud.state.completes).toEqual([]);
  });

  it('--once runs one job and exits; with nothing to do it exits at once', async () => {
    const cloud = fakeCloud();
    cloud.state.jobs.push(job());
    await startRunner({ ...options(cloud), once: true }).done;
    expect(cloud.state.completes).toHaveLength(1);
    await startRunner({ ...options(cloud), once: true }).done;
    expect(cloud.state.completes).toHaveLength(1);
  });

  it('keeps the env small and the output line strict', () => {
    const env = jobEnv(job({ env: { A: '1' } }), { SHIPCUE_TOKEN: 't', HOME: '/h' }, '/o.json');
    expect(env).toMatchObject({ A: '1', HOME: '/h', SHIPCUE_RUN_ID: 'run-1', SHIPCUE_STEP: 'gates', SHIPCUE_OUTPUT_FILE: '/o.json', SHIPCUE_INPUT_REPORT_ID: 'r1' });
    expect(env.SHIPCUE_TOKEN).toBeUndefined();
    expect(shellOutput('a\n::output {"x":1}\n::output {"x":2}\n', null)).toEqual({ x: 2 });
    // Only declared project secrets reach a step; the clone's GITHUB_TOKEN stays with the runner.
    const cloudEnv = { SHIPCUE_SECRET_GITHUB_TOKEN: 'ghp_x', SHIPCUE_SECRET_ANTHROPIC_API_KEY: 'sk-ant-x', SHIPCUE_SECRET_OPENAI_API_KEY: 'sk-oa' };
    const plain = jobEnv(job(), cloudEnv, '/o.json');
    expect(Object.keys(plain).filter((k) => /TOKEN|KEY|SECRET|GIT_CONFIG/.test(k))).toEqual([]);
    const agent = jobEnv(job({ secrets: ['ANTHROPIC_API_KEY'] }), cloudEnv, '/o.json');
    expect(agent.ANTHROPIC_API_KEY).toBe('sk-ant-x');
    expect(agent.GITHUB_TOKEN).toBeUndefined();
    expect(agent.OPENAI_API_KEY).toBeUndefined();
    const pusher = jobEnv(job({ secrets: ['GITHUB_TOKEN'] }), cloudEnv, '/o.json');
    expect(pusher).toMatchObject({ GITHUB_TOKEN: 'ghp_x', GH_TOKEN: 'ghp_x', GIT_CONFIG_COUNT: '1', GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from('x-access-token:ghp_x').toString('base64')}` });
    expect(shellOutput('nothing', null)).toBeNull();
  });
});

describe('the CLI', () => {
  it('workflows init writes the workflow and a gates script that sh can read', () => {
    const r = workflowsInit({ cwd: dir, args: [], env: {} });
    expect(r.code).toBe(0);
    const wf = readFileSync(join(dir, '.shipcue/workflows/fix-report.yml'), 'utf8');
    expect(wf).toContain('name: fix-report');
    expect(wf).toContain('approval: required');
    expect(wf).not.toMatch(/run: .*\$\{\{/);
    const gates = join(dir, 'scripts/ship-gates.sh');
    expect(spawnSync('sh', ['-n', gates]).status).toBe(0);
    expect(workflowsInit({ cwd: dir, args: [], env: {} }).output).toContain('already exists');
  });

  it('workflows push checks every file first and pushes nothing when one is wrong', async () => {
    workflowsInit({ cwd: dir, args: [], env: {} });
    writeFileSync(join(dir, '.shipcue/workflows/broken.yml'), 'name: broken\nsteps: {}\n');
    const cloud = fakeCloud();
    cloud.state.pushAnswers.broken = { status: 422, body: { error: 'The workflow has problems.', errors: ['steps: a map of at least one step'] } };
    const bad = await workflowsPush({ cwd: dir, args: [], env: {} }, cloud.client);
    expect(bad.code).toBe(1);
    expect(bad.output).toContain('✗ steps: a map of at least one step');
    expect(cloud.calls.filter((c) => c.path === '/workflows' && c.body && !c.body.dryRun)).toEqual([]);
    delete cloud.state.pushAnswers.broken;
    const ok = await workflowsPush({ cwd: dir, args: [], env: {} }, cloud.client);
    expect(ok).toMatchObject({ code: 0 });
    expect(ok.output).toContain('pushed fix-report');
  });

  it('run starts a run and follows it to the end', async () => {
    const cloud = fakeCloud();
    const step = (status: string, over = {}) => ({ key: 'build', kind: 'agent', status, attempt: 1, runner: 'mini', question: null, output: null, exitCode: null, error: null, logTail: '', lastSeq: null, ...over });
    const run = (status: string, s: unknown) => ({ run: { id: 'run-9', workflow: 'fix-report', status, inputs: {}, createdAt: '', finishedAt: null, url: 'https://cloud.example.com/app/?p=x&tab=runs&run=run-9' }, steps: [s] });
    cloud.state.runs.push(run('running', step('running', { lastSeq: 0 })), run('succeeded', step('succeeded', { lastSeq: 0 })));
    let printed = '';
    const r = await runCommand({ cwd: dir, args: ['fix-report', '--input', 'report_id=r1'], env: {}, out: (s) => (printed += s), sleep: async () => {} }, cloud.client, URL_);
    expect(r).toEqual({ output: 'run run-9: succeeded\n', code: 0 });
    expect(cloud.calls.find((c) => c.path === '/workflows/fix-report/runs')!.body).toEqual({ inputs: { report_id: 'r1' } });
    expect(printed).toContain('build: running on mini');
    expect(printed).toContain('build | built it');
    expect(printed).toContain('https://cloud.example.com/app/?p=x&tab=runs&run=run-9');
  });

  it('needs a Cloud project endpoint and a token', async () => {
    expect((await workflowsCli('workflows', { cwd: dir, args: ['list'], env: {} })).output).toMatch(/Set SHIPCUE_URL/);
    expect((await workflowsCli('workflows', { cwd: dir, args: ['list'], env: { SHIPCUE_URL: 'https://app.example.com/api/shipcue', SHIPCUE_TOKEN: 't' } })).output).toMatch(/project endpoint/);
  });

  it('runner install --print shows a launchd or systemd service with the token hidden', () => {
    const conn = { url: URL_, token: 'sca_secret' };
    const mac = runnerInstall({ cwd: dir, args: ['--print', '--platform', 'darwin', '--capacity', '2', '--name', 'mini'], env: { HOME: '/Users/ada' } }, conn);
    expect(mac.output).toContain('/Users/ada/Library/LaunchAgents/com.shipcue.runner-');
    expect(mac.output).toContain('shipcue runner --name mini --capacity 2 --repo');
    expect(mac.output).not.toContain('sca_secret');
    const linux = runnerInstall({ cwd: dir, args: ['--print', '--platform', 'linux'], env: { HOME: '/home/ada' } }, conn);
    expect(linux.output).toContain('/home/ada/.config/systemd/user/shipcue-runner-');
    expect(linux.output).toContain('KillSignal=SIGTERM');
  });

  it('service files keep their text literal', () => {
    const spec = { name: 'r', description: '50% $HOME', command: 'echo "$X" 100%', env: { SHIPCUE_TOKEN: 'a&b' }, workingDirectory: '~/code' };
    expect(launchdPlist(spec, '/Users/a')).toContain('<string>a&amp;b</string>');
    expect(launchdPlist(spec, '/Users/a')).toContain('<string>/Users/a/code</string>');
    expect(systemdUnit(spec)).toContain('ExecStart=/bin/bash -lc "echo \\"$$X\\" 100%%"');
  });
});

describe('MCP workflow tools', () => {
  it('list, start, get and cancel; there is no approve tool', async () => {
    const cloud = fakeCloud();
    const tools = workflowTools(cloud.client, URL_);
    expect(tools.map((t) => t.name)).toEqual(['list_workflows', 'start_run', 'get_run', 'cancel_run']);
    expect(tools.some((t) => /approve/.test(t.name))).toBe(false);
    expect(await tools[0]!.handler({})).toContain('fix-report');
    cloud.state.runs.push({
      run: { id: 'run-1', workflow: 'fix-report', status: 'awaiting_approval', inputs: {}, createdAt: '', finishedAt: null },
      steps: [{ key: 'claim', kind: 'builtin', status: 'blocked', attempt: 1, runner: null, question: null, output: null, exitCode: null, error: null, logTail: '', lastSeq: null }],
    });
    const started = await tools[1]!.handler({ workflow: 'fix-report', inputs: { report_id: 'r1' } });
    expect(started).toContain('awaiting_approval (a person must approve it in the app)');
  });
});
