// What changed between two looks at the queue, as events (shipcue report 8c11cf21). The
// shipcue-listen command polls with the agent token and runs a command per event, so an
// agent on a Mac mini, a VPS or behind Tailscale hears about reports without opening a port.
import type { Report } from '../core';

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
