// Read-only telemetry for orchestration observability (Phase 6). SECURITY-CRITICAL: this layer
// surfaces METADATA, never CONTENT. It reads the existing tables and adds NO new persisted data, so it
// cannot become a new exfiltration surface.
//
// Two hard rules, enforced structurally (not by hope):
//   1. `runs` is read via an EXPLICIT safe-column projection (SAFE_RUN_COLS) — NEVER `toRun()` / SELECT
//      *, which would carry `prompt` + `output` (raw, secret-bearing). prompt/output/changedFiles/
//      errorSignature are never selected here.
//   2. `task_events` is COUNT-BY-TYPE ONLY — its `payloadJson` carries the RAW agent.output stdout
//      chunk (events.ts persists every event before fan-out), so it is NEVER projected; we select only
//      `type` + COUNT(*).
// The leak test plants secrets in exactly those forbidden columns and proves they never appear.
import { type SQL, eq, sql } from 'drizzle-orm';
import { getDb } from '../db';
import { runs, taskEvents, tasks, tickets } from '../schema';

export interface SafeRunRow {
  provider: string;
  requestedProvider: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  durationMs: number | null;
  status: string;
}

// The ONLY run columns observability may read. No prompt, no output, no changedFilesJson, no
// errorSignature (content-derived). Adding a raw-text column here is the leak the test guards.
const SAFE_RUN_COLS = {
  provider: runs.provider,
  requestedProvider: runs.requestedProvider,
  inputTokens: runs.inputTokens,
  outputTokens: runs.outputTokens,
  costUsd: runs.costUsd,
  durationMs: runs.durationMs,
  status: runs.status,
};

export function safeRunsForProject(projectId: string): SafeRunRow[] {
  return getDb()
    .select(SAFE_RUN_COLS)
    .from(runs)
    .innerJoin(tasks, eq(runs.taskId, tasks.id))
    .innerJoin(tickets, eq(tasks.ticketId, tickets.id))
    .where(eq(tickets.projectId, projectId))
    .all();
}

export function safeRunsForTicket(ticketId: string): SafeRunRow[] {
  return getDb()
    .select(SAFE_RUN_COLS)
    .from(runs)
    .innerJoin(tasks, eq(runs.taskId, tasks.id))
    .where(eq(tasks.ticketId, ticketId))
    .all();
}

/** type → count over task_events. NEVER reads payloadJson (which holds raw agent.output). */
function eventCounts(where: SQL): Record<string, number> {
  const rows = getDb()
    .select({ type: taskEvents.type, n: sql<number>`count(*)` })
    .from(taskEvents)
    .innerJoin(tickets, eq(taskEvents.ticketId, tickets.id))
    .where(where)
    .groupBy(taskEvents.type)
    .all();
  return Object.fromEntries(rows.map((r) => [r.type, Number(r.n)]));
}

export function eventCountsForProject(projectId: string): Record<string, number> {
  return eventCounts(eq(tickets.projectId, projectId));
}
export function eventCountsForTicket(ticketId: string): Record<string, number> {
  return eventCounts(eq(taskEvents.ticketId, ticketId));
}
