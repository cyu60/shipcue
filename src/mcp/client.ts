import type { Report, Status } from '../core';

export interface AgentClientOptions {
  /** Where createShipcueHandler is mounted, e.g. https://app.example.com/api/shipcue */
  url: string;
  token: string;
  /** Name stored as claimed_by, e.g. "claude-code@laptop". */
  agent?: string;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}

export interface Claimed {
  report: Report;
  prompt: string;
}

/** Thin HTTP client for the agent API. The MCP tools are built on it. */
export function createAgentClient(opts: AgentClientOptions) {
  const base = opts.url.replace(/\/$/, '');
  const doFetch = opts.fetch ?? ((u: string, i?: RequestInit) => fetch(u, i));
  const agent = opts.agent ?? 'agent';

  async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T | null> {
    const res = await doFetch(`${base}/reports${path}`, {
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${opts.token}`, 'content-type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if (res.status === 204) return null;
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(body.error ?? `shipcue responded ${res.status}`);
    return body as T;
  }
  const post = <T>(path: string, body: unknown = {}) => call<T>(path, { method: 'POST', body });

  return {
    async list(status?: Status): Promise<Report[]> {
      const q = status ? `?status=${encodeURIComponent(status)}` : '';
      return (await call<{ reports: Report[] }>(q))!.reports;
    },
    async get(id: string): Promise<Claimed> {
      return (await call<Claimed>(`/${encodeURIComponent(id)}`))!;
    },
    claimNext: (): Promise<Claimed | null> => post<Claimed>('/next/claim', { agent }),
    async claim(id: string): Promise<Claimed> {
      return (await post<Claimed>(`/${encodeURIComponent(id)}/claim`, { agent }))!;
    },
    async release(id: string): Promise<Report> {
      return (await post<{ report: Report }>(`/${encodeURIComponent(id)}/release`))!.report;
    },
    async close(id: string, status: 'fixed' | 'wontfix', resolution?: string): Promise<Report> {
      return (await post<{ report: Report }>(`/${encodeURIComponent(id)}/close`, { status, resolution }))!.report;
    },
  };
}

export type AgentClient = ReturnType<typeof createAgentClient>;
