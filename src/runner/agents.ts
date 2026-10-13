// How a runner asks a coding agent for one step's answer. Every claude/codex flag lives in
// agentCommand(), so a CLI change is a one-place fix. Checked against claude 2.1.296
// (`claude --help`: -p, --output-format json, --json-schema <schema>) and codex-cli 0.160.1
// (`codex exec --help`: -C <dir>, --skip-git-repo-check, --output-schema <file>, -o <file>).

export interface AgentCommand {
  cmd: string;
  args: string[];
  /** The agent's answer from what it printed (and the files it wrote). Throws when there is none. */
  parse(stdout: string, readFile: (path: string) => string | null): unknown;
}

const SCHEMA_NOTE = 'When you are done, answer with only a JSON value that fits this JSON Schema, nothing else:';

/** The prompt, with the schema the answer must fit (both CLIs also enforce it themselves). */
export function agentPrompt(prompt: string, schema: Record<string, unknown> | null, retryErrors: string[] = []): string {
  const parts = [prompt.trim()];
  if (schema) parts.push(`${SCHEMA_NOTE}\n${JSON.stringify(schema)}`);
  if (retryErrors.length) parts.push(`Your last answer did not fit the schema: ${retryErrors.join('; ')}. Answer again with only the JSON.`);
  return parts.join('\n\n');
}

/**
 * The command for one agent step.
 *   claude -p <prompt> --output-format json [--json-schema <schema>] ...extra
 *   codex exec --skip-git-repo-check -C <cwd> [--output-schema <file>] -o <file> ...extra <prompt>
 * extra: flags from the runner's --claude-args / --codex-args (e.g. a permission mode).
 */
export function agentCommand(
  agent: 'claude' | 'codex',
  o: { prompt: string; schema: Record<string, unknown> | null; cwd: string; schemaFile: string; answerFile: string; extra?: string[] },
): AgentCommand {
  const extra = o.extra ?? [];
  if (agent === 'claude') {
    return {
      cmd: 'claude',
      args: ['-p', o.prompt, '--output-format', 'json', ...(o.schema ? ['--json-schema', JSON.stringify(o.schema)] : []), ...extra],
      parse(stdout) {
        // --output-format json prints one object: the reply in `result`, and with --json-schema the
        // checked value in `structured_output`.
        const reply = lastJson(stdout);
        if (reply && typeof reply === 'object' && !Array.isArray(reply)) {
          const r = reply as Record<string, unknown>;
          if (r.is_error === true) throw new Error(`claude: ${String(r.result ?? 'failed')}`);
          if (r.structured_output !== undefined) return r.structured_output;
          if (typeof r.result === 'string') return o.schema ? answerFrom(r.result) : { text: r.result };
        }
        throw new Error('claude printed no answer');
      },
    };
  }
  return {
    cmd: 'codex',
    args: ['exec', '--skip-git-repo-check', '-C', o.cwd, ...(o.schema ? ['--output-schema', o.schemaFile] : []), '-o', o.answerFile, ...extra, o.prompt],
    parse(_stdout, readFile) {
      // -o writes the last message; with --output-schema it is the JSON answer.
      const text = readFile(o.answerFile);
      if (text === null) throw new Error('codex wrote no answer');
      return o.schema ? answerFrom(text) : { text: text.trim() };
    },
  };
}

/** The JSON in an agent's reply: the whole text, a ```json fence, or the last {...} in it. */
export function answerFrom(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    // Look further.
  }
  const fence = [...t.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].at(-1);
  if (fence) {
    try {
      return JSON.parse(fence[1]!.trim());
    } catch {
      // Look further.
    }
  }
  const found = lastJson(t);
  if (found !== undefined) return found;
  throw new Error('the agent did not answer with JSON');
}

/** The last parseable JSON object (or line) in some text. */
function lastJson(text: string): unknown {
  const lines = text.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith('{') && !line.startsWith('[')) continue;
    try {
      return JSON.parse(line);
    } catch {
      // A multi-line object: try from here to the end.
      try {
        return JSON.parse(lines.slice(i).join('\n'));
      } catch {
        // Keep looking.
      }
    }
  }
  return undefined;
}
