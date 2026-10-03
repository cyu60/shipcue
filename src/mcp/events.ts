// What changed between two looks at the queue, as events (shipcue report 8c11cf21). The
// shipcue-listen command polls with the agent token and runs a command per event, so an
// agent on a Mac mini, a VPS or behind Tailscale hears about reports without opening a port.
import { validateScope, type Report, type Result } from '../core';

// 'assigned': someone queued an open report for an agent from the CueLog (shipcue report 3d2dded6).
export type ListenEvent = 'filed' | 'assigned' | 'claimed' | 'released' | 'closed' | 'video';
export const LISTEN_EVENTS: ListenEvent[] = ['filed', 'assigned', 'claimed', 'released', 'closed', 'video'];

export interface Change {
  type: `report.${ListenEvent}`;
  report: Report;
}

/** The events between the last look (by id) and this one, oldest report first. */
export function diffReports(before: Map<string, Report>, now: Report[]): Change[] {
  const out: Change[] = [];
  const sorted = [...now].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const r of sorted) {
    const was = before.get(r.id);
    if (!was) {
      out.push({ type: 'report.filed', report: r });
      continue;
    }
    if (was.status !== r.status) {
      if (r.status === 'claimed') out.push({ type: 'report.claimed', report: r });
      else if (r.status === 'open') out.push({ type: 'report.released', report: r });
      else out.push({ type: 'report.closed', report: r });
    } else if (r.status === 'open' && r.claimantKind === 'agent' && r.claimantId && was.claimantId !== r.claimantId) {
      out.push({ type: 'report.assigned', report: r });
    }
    if (!was.video && r.video) out.push({ type: 'report.video', report: r });
  }
  return out;
}

/**
 * shipcue-listen --scope: the JSON work area its agent's claims declare (shipcue report 83f5d976),
 * checked and normalised for SHIPCUE_SCOPE; undefined when not given or empty.
 */
export function parseScopeFlag(raw: string | undefined): Result<string | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: `takes JSON, e.g. '{"paths":["src/server/**"]}'` };
  }
  const v = validateScope(parsed);
  if (!v.ok) return v;
  return { ok: true, value: v.value ? JSON.stringify(v.value) : undefined };
}
