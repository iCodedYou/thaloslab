// Orchestration telemetry rollups (Phase 6) — pure aggregation over the safe, metadata-only rows from
// the observability repo. Every field below is an integer/enum/sum; no string carrying user or agent
// content ever appears. Per-PEER rollups key on `provider='collab:<peerId>'` + integer tokens/cost —
// they expose WHO computed and HOW MUCH, never WHAT crossed.
import {
  type SafeRunRow,
  eventCountsForProject,
  eventCountsForTicket,
  safeRunsForProject,
  safeRunsForTicket,
} from '../store/repositories/observability';

export interface Rollup {
  scopeId: string;
  scopeKind: 'project' | 'ticket' | 'provider' | 'peer';
  runCount: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  statusBreakdown: Record<string, number>; // run status → count (ok/error/interrupted/running)
}

function rollup(scopeId: string, scopeKind: Rollup['scopeKind'], rows: SafeRunRow[]): Rollup {
  const r: Rollup = {
    scopeId,
    scopeKind,
    runCount: rows.length,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    durationMs: 0,
    statusBreakdown: {},
  };
  for (const row of rows) {
    r.inputTokens += row.inputTokens ?? 0;
    r.outputTokens += row.outputTokens ?? 0;
    r.costUsd += row.costUsd ?? 0;
    r.durationMs += row.durationMs ?? 0;
    r.statusBreakdown[row.status] = (r.statusBreakdown[row.status] ?? 0) + 1;
  }
  return r;
}

function byProvider(rows: SafeRunRow[]): Rollup[] {
  const groups = new Map<string, SafeRunRow[]>();
  for (const row of rows) {
    const arr = groups.get(row.provider) ?? [];
    arr.push(row);
    groups.set(row.provider, arr);
  }
  return [...groups.entries()]
    .map(([p, rs]) => rollup(p, 'provider', rs))
    .sort((a, b) => b.costUsd - a.costUsd);
}

export interface ProjectTelemetry {
  project: Rollup;
  byProvider: Rollup[];
  /** Collab attribution: providers of the form `collab:<peerId>:<vendor>`. */
  byPeer: Rollup[];
  escalationCount: number;
  /** task_event type → count (all type strings are safe enum-ish names; counts only). */
  eventCounts: Record<string, number>;
}

export function projectTelemetry(projectId: string): ProjectTelemetry {
  const rows = safeRunsForProject(projectId);
  const providers = byProvider(rows);
  const events = eventCountsForProject(projectId);
  return {
    project: rollup(projectId, 'project', rows),
    byProvider: providers,
    byPeer: providers
      .filter((p) => p.scopeId.startsWith('collab:'))
      .map((p) => ({ ...p, scopeKind: 'peer' as const })),
    escalationCount: events.escalation ?? 0,
    eventCounts: events,
  };
}

export interface TicketTelemetry {
  ticket: Rollup;
  byProvider: Rollup[];
  escalationCount: number;
  eventCounts: Record<string, number>;
}

export function ticketTelemetry(ticketId: string): TicketTelemetry {
  const rows = safeRunsForTicket(ticketId);
  const events = eventCountsForTicket(ticketId);
  return {
    ticket: rollup(ticketId, 'ticket', rows),
    byProvider: byProvider(rows),
    escalationCount: events.escalation ?? 0,
    eventCounts: events,
  };
}
