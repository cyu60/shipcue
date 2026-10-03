// "Copy prompt for my agent" (shipcue report 9f533ece): everything the panel would send, as a
// prompt Claude Code or Codex can act on, so the agent fills the form out and files it.

import { PRIORITIES, PRIORITY_HINT, type Area, type Priority, type ReportType } from '../core';

/** How the agent authenticates when the endpoint needs it (ReportButton's agentPromptAuth). */
export interface AgentPromptAuth {
  /** The header to send, with a placeholder for the secret: 'Authorization: Bearer <token>'. */
  header: string;
  /** Where to get a token, e.g. https://app.example.com/settings/tokens. */
  where?: string;
}

export interface AgentPromptInput {
  /** The app's name, e.g. document.title. */
  app: string;
  /** The page the report is about, or null when the person chose not to attach it. */
  pageUrl: string | null;
  /** The handler, made absolute (https://app.example.com/api/shipcue). */
  endpoint: string;
  type: ReportType;
  /** The tabs on show, so the agent only picks from those. */
  types: ReportType[];
  priority: Priority;
  area: string;
  areas: Area[];
  text: string;
  context: string | null;
  /** The diagnostics snapshot as JSON text, as the panel attaches it. */
  diagnostics: string;
  reporter?: string;
  auth?: AgentPromptAuth;
}

/** A word for the shell, single-quoted. */
const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const fence = (s: string) => `\`\`\`\n${s}\n\`\`\``;

export function agentPrompt(p: AgentPromptInput): string {
  const typeName: Record<ReportType, string> = { bug: 'a bug report', feature: 'a feature request', task: 'an agent task' };
  const asks: Record<ReportType, string> = {
    bug: 'what I did, what happened, and what I expected instead',
    feature: 'what I want and why it would help',
    task: 'what the agent should do, and how we will know it is done',
  };
  const lines = [
    `Help me file ${typeName[p.type]} for ${p.app} through shipcue, its report queue. Fill the form out for me, then file it.`,
    '',
    `App: ${p.app}`,
    `Page: ${p.pageUrl ?? '(not attached)'}`,
    `Endpoint: ${p.endpoint}`,
    '',
    '## The form',
    `Type: ${p.type}   (one of: ${p.types.join(', ')})`,
    `Priority: ${p.priority}   (one of: ${PRIORITIES.map((x) => `${x} = ${PRIORITY_HINT[x]}`).join('; ')})`,
    `Area: ${p.area}   (one of: ${p.areas.map((a) => `${a.value} (${a.label})`).join(', ')})`,
    '',
    '## What I have written so far',
    p.text.trim() ? fence(p.text.trim()) : 'Nothing yet.',
  ];
  if (p.context?.trim()) lines.push('', '## Context I picked out on the page', fence(p.context.trim()));
  lines.push(
    '',
    '## Diagnostics shipcue attaches (send unchanged)',
    fence(p.diagnostics),
    '',
    ...(p.auth
      ? [
          '## Auth',
          `This endpoint needs \`${p.auth.header}\` on every request.${p.auth.where ? ` Get a token at ${p.auth.where}` : ' Ask me for a token'}; never print it back to me.`,
          '',
        ]
      : []),
    '## How to file it',
    `1. Ask me for anything missing before filing: ${asks[p.type]}. Keep my words; confirm the type, priority and area with me.`,
    '2. If you have the shipcue MCP server, call its file_report tool with type, description, priority, area, page_url, context and diagnostics (as above).',
    `   Not set up? \`claude mcp add shipcue -e SHIPCUE_URL=${p.endpoint}${p.auth ? ' -e SHIPCUE_TOKEN=<token>' : ''} -- npx shipcue-mcp\`, or use step 3.`,
    '3. Otherwise run this, with the description filled in:',
    // Free text goes as --form-string: with -F, a value starting with @ or < is read as a file.
    fence(
      [
        `curl -X POST ${sh(`${p.endpoint}/reports`)}`,
        ...(p.reporter ? [`-H ${sh(`x-shipcue-user: ${p.reporter}`)}`] : []),
        ...(p.auth ? [`-H ${sh(p.auth.header)}`] : []),
        `-F ${sh(`type=${p.type}`)} -F ${sh(`priority=${p.priority}`)} -F ${sh(`area=${p.area}`)}`,
        `--form-string description=${sh(p.text.trim() || '<the report>')}`,
        ...(p.context?.trim() ? [`--form-string ${sh(`context=${p.context.trim()}`)}`] : []),
        `-F ${sh(`pageUrl=${p.pageUrl ?? ''}`)}`,
        `--form-string diagnostics=${sh(p.diagnostics)}`,
      ].join(' \\\n  '),
    ),
    '4. Tell me the report id it returns.',
  );
  return lines.join('\n');
}
