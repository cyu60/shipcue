// shipcue Cloud Workflows as MCP tools: list, start, read and cancel runs. There is no approve tool:
// a person approves a run in the app (or from its notification), never an agent.
import { z } from 'zod';
import { RUN_DONE, runPageUrl, type RunDetail, type WorkflowClient } from '../runner/client';

/** A run in a few lines an agent can act on. */
export function runText(d: RunDetail, url: string): string {
  const head = `Run ${d.run.id} of ${d.run.workflow}: ${d.run.status}${d.run.status === 'awaiting_approval' ? ' (a person must approve it in the app)' : ''}`;
  const steps = d.steps.map((s) => {
    const extra = [
      s.runner ? `on ${s.runner}` : null,
      s.question && s.status === 'waiting_approval' ? `waiting for a person: "${s.question}"` : null,
      s.error,
      s.output ? `output ${JSON.stringify(s.output)}` : null,
    ]
      .filter(Boolean)
      .join('; ');
    return `- ${s.key}: ${s.status}${extra ? ` (${extra})` : ''}`;
  });
  const tail = RUN_DONE.includes(d.run.status) ? [] : d.steps.filter((s) => s.logTail && s.status === 'running').map((s) => `\n${s.key} log (end):\n${s.logTail.slice(-1500)}`);
  return [head, ...steps, `Page: ${runPageUrl(url, d.run.id)}`, ...tail].join('\n');
}

export interface WorkflowTool {
  name: string;
  description: string;
  inputSchema: Record<string, z.ZodType>;
  handler: (args: any) => Promise<string>;
}

export function workflowTools(client: WorkflowClient, url: string): WorkflowTool[] {
  return [
    {
      name: 'list_workflows',
      description: "List this shipcue Cloud project's workflows: their steps, inputs, triggers and whether a run needs a person's approval.",
      inputSchema: {},
      handler: async () => {
        const list = await client.listWorkflows();
        if (!list.length) return 'No workflows. `npx shipcue workflows init` and `push` add one.';
        return list
          .map((w) => {
            const inputs = Object.entries(w.inputs)
              .map(([k, i]) => `${k}${i.required ? '' : '?'}: ${i.type}`)
              .join(', ');
            return `${w.name}${w.description ? ` — ${w.description}` : ''}\n  inputs: ${inputs || 'none'}; steps: ${w.steps.map((s) => s.key).join(' → ')}; ${w.approval === 'required' ? 'each run needs approval' : 'runs without approval'}`;
          })
          .join('\n');
      },
    },
    {
      name: 'start_run',
      description:
        "Start a run of a workflow. If the workflow needs approval the run waits until a person approves it in the app; you cannot approve it. Returns the run's id and state.",
      inputSchema: { workflow: z.string(), inputs: z.record(z.string(), z.string()).optional().describe('The workflow inputs, e.g. {"report_id": "…"}.') },
      handler: async ({ workflow, inputs }: { workflow: string; inputs?: Record<string, string> }) => runText(await client.startRun(workflow, inputs ?? {}), url),
    },
    {
      name: 'get_run',
      description: "A run's state: each step's status, runner, output and error, and the end of a running step's log.",
      inputSchema: { run_id: z.string() },
      handler: async ({ run_id }: { run_id: string }) => runText(await client.getRun(run_id), url),
    },
    {
      name: 'cancel_run',
      description: 'Cancel a run that has not finished. Its runners are told to stop.',
      inputSchema: { run_id: z.string() },
      handler: async ({ run_id }: { run_id: string }) => runText(await client.cancelRun(run_id), url),
    },
  ];
}
