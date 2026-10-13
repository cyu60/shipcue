// The shipcue Cloud workflow API, as a runner and the CLI call it (docs: shipcue Cloud, Workflows).
// url is the project's endpoint, https://shipcue.ibuildathing.com/api/cloud/p/<pk_…>, the same
// SHIPCUE_URL the MCP server and shipcue-listen use; token is the project's agent token (sca_…).

export interface Job {
  id: string;
  runId: string;
  workflow: string;
  step: string;
  attempt: number;
  kind: 'shell' | 'agent';
  /** The shell command (shell steps). Values reach it only through env. */
  run: string | null;
  agent: 'claude' | 'codex' | null;
  /** The prompt with every ${{ }} filled in (agent steps). */
  prompt: string | null;
  /** The JSON Schema the agent's answer must fit, or null for any. */
  output: Record<string, unknown> | null;
  env: Record<string, string>;
  inputs: Record<string, unknown>;
  timeoutSeconds: number;
  leaseSeconds: number;
  heartbeatSeconds: number;
}

export interface RunnerInfo {
  name: string;
  labels: string[];
  os: string;
  version: string;
  capacity: number;
}

export interface CompleteBody {
  status: 'succeeded' | 'failed';
  attempt: number;
  exitCode?: number | null;
  output?: unknown;
  error?: string;
}

/** What Cloud said to a result: ok, ask the agent again (422 retry), or stop (409 cancel). */
export type CompleteAnswer = { ok: true } | { ok: false; retry: boolean; cancel: boolean; errors: string[]; error: string };

export interface WorkflowSummary {
  name: string;
  description: string | null;
  approval: 'required' | 'none';
  on: { manual: boolean; report: string[]; schedule: string | null };
  inputs: Record<string, { type: string; required: boolean; default: unknown }>;
  steps: { key: string; kind: string; needs: string[] }[];
}

export interface RunStep {
  key: string;
  kind: string;
  status: string;
  attempt: number;
  runner: string | null;
  question: string | null;
  output: unknown;
  exitCode: number | null;
  error: string | null;
  logTail: string;
  lastSeq: number | null;
}

export interface RunDetail {
  run: { id: string; workflow: string; status: string; inputs: Record<string, unknown>; createdAt: string; finishedAt: string | null };
  steps: RunStep[];
}

export const RUN_DONE = ['succeeded', 'failed', 'cancelled'];

export class CloudError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CloudError';
  }
}

export function createWorkflowClient(o: { url: string; token: string; fetch?: (url: string, init?: RequestInit) => Promise<Response> }) {
  const base = o.url.replace(/\/+$/, '');
  const f = o.fetch ?? fetch;
  async function call(method: string, path: string, body?: unknown): Promise<{ status: number; data: Record<string, any> }> {
    const res = await f(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${o.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = res.status === 204 ? {} : ((await res.json().catch(() => ({}))) as Record<string, any>);
    return { status: res.status, data };
  }
  const ok = async (method: string, path: string, body?: unknown) => {
    const r = await call(method, path, body);
    if (r.status >= 400) throw new CloudError(String(r.data.error ?? `shipcue Cloud said ${r.status}`), r.status, r.data);
    return r.data;
  };
  return {
    /** A job for this runner, or null when there is nothing it can take. */
    async claim(me: RunnerInfo): Promise<Job | null> {
      const r = await call('POST', '/runner/claim', me);
      if (r.status === 204) return null;
      if (r.status >= 400) throw new CloudError(String(r.data.error ?? `claim: ${r.status}`), r.status, r.data);
      return r.data.job as Job;
    },
    /** True while the job is still this runner's; false means stop it (cancelled, expired). */
    async heartbeat(jobId: string): Promise<boolean> {
      const r = await call('POST', `/runner/jobs/${jobId}/heartbeat`, {});
      if (r.status === 409 || r.status === 404) return false;
      if (r.status >= 400) throw new CloudError(String(r.data.error ?? `heartbeat: ${r.status}`), r.status, r.data);
      return true;
    },
    async log(jobId: string, seq: number, chunk: string): Promise<boolean> {
      const r = await call('POST', `/runner/jobs/${jobId}/log`, { seq, chunk });
      return r.status < 400;
    },
    async complete(jobId: string, body: CompleteBody): Promise<CompleteAnswer> {
      const r = await call('POST', `/runner/jobs/${jobId}/complete`, body);
      if (r.status < 300) return { ok: true };
      if (r.status >= 500) throw new CloudError(String(r.data.error ?? `complete: ${r.status}`), r.status, r.data);
      return { ok: false, retry: r.data.retry === true, cancel: r.data.cancel === true, errors: (r.data.errors as string[]) ?? [], error: String(r.data.error ?? r.status) };
    },
    async release(jobId: string): Promise<void> {
      await call('POST', `/runner/jobs/${jobId}/release`, {});
    },
    async listWorkflows(): Promise<WorkflowSummary[]> {
      return (await ok('GET', '/workflows')).workflows;
    },
    /** Checks (dryRun) or saves a workflow file; Cloud answers 422 with errors that name the step. */
    async push(source: string, dryRun = false): Promise<{ workflow: { name: string }; created?: boolean; version?: { sha: string } }> {
      return (await ok('POST', '/workflows', { source, dryRun })) as any;
    },
    async startRun(name: string, inputs: Record<string, unknown>): Promise<RunDetail> {
      return (await ok('POST', `/workflows/${encodeURIComponent(name)}/runs`, { inputs })) as RunDetail;
    },
    async getRun(id: string): Promise<RunDetail> {
      return (await ok('GET', `/runs/${encodeURIComponent(id)}`)) as RunDetail;
    },
    async listRuns(params: { status?: string; workflow?: string } = {}): Promise<RunDetail['run'][]> {
      const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();
      return (await ok('GET', `/runs${qs ? `?${qs}` : ''}`)).runs;
    },
    async cancelRun(id: string): Promise<RunDetail> {
      return (await ok('POST', `/runs/${encodeURIComponent(id)}/cancel`, {})) as RunDetail;
    },
    async stepLog(runId: string, step: string, after = -1): Promise<{ seq: number; chunk: string }[]> {
      return (await ok('GET', `/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(step)}/log?after=${after}`)).chunks;
    },
  };
}

export type WorkflowClient = ReturnType<typeof createWorkflowClient>;

/** The app's page for a run, from the project endpoint (…/api/cloud/p/<key> → …/app/). */
export function runPageUrl(url: string, runId: string): string {
  const origin = new URL(url).origin;
  return `${origin}/app/#runs/${runId}`;
}
