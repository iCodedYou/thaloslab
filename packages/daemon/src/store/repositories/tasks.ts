// Data access for `tasks` (Phase 1). Includes the atomic single-flight claim used by the
// scheduler so concurrent advance() triggers can't double-dispatch a task.
import { and, eq } from 'drizzle-orm';
import type { Task, TaskKind, TaskState } from '@thaloslab/shared';
import { getDb } from '../db';
import { tasks } from '../schema';

type Row = typeof tasks.$inferSelect;

function toTask(row: Row): Task {
  return {
    id: row.id,
    ticketId: row.ticketId,
    stageId: row.stageId,
    kind: row.kind as TaskKind,
    laneId: row.laneId ?? `${row.ticketId}:main`,
    seamPaths: row.seamPathsJson ? (JSON.parse(row.seamPathsJson) as string[]) : undefined,
    agentId: row.agentId ?? undefined,
    dependsOn: row.dependsOnJson ? (JSON.parse(row.dependsOnJson) as string[]) : [],
    worktreePath: row.worktreePath ?? undefined,
    branch: row.branch ?? undefined,
    state: row.state as TaskState,
    retryCount: row.retryCount ?? 0,
    attempt: row.attempt ?? 0,
    lastError: row.lastError ?? undefined,
    lastErrorSignature: row.lastErrorSignature ?? undefined,
    startedAt: row.startedAt ?? undefined,
    endedAt: row.endedAt ?? undefined,
    updatedAt: row.updatedAt ?? undefined,
    createdAt: row.createdAt,
  };
}

/** Input for inserting a task; `laneId` defaults to the ticket's main lane when omitted. */
export type NewTask = Omit<Task, 'laneId'> & { laneId?: string };

export function insertTask(t: NewTask): Task {
  const laneId = t.laneId ?? `${t.ticketId}:main`;
  getDb()
    .insert(tasks)
    .values({
      id: t.id,
      ticketId: t.ticketId,
      stageId: t.stageId,
      kind: t.kind,
      laneId,
      seamPathsJson: t.seamPaths ? JSON.stringify(t.seamPaths) : null,
      agentId: t.agentId ?? null,
      dependsOnJson: JSON.stringify(t.dependsOn ?? []),
      worktreePath: t.worktreePath ?? null,
      branch: t.branch ?? null,
      state: t.state,
      retryCount: t.retryCount ?? 0,
      attempt: t.attempt ?? 0,
      lastError: t.lastError ?? null,
      lastErrorSignature: t.lastErrorSignature ?? null,
      startedAt: t.startedAt ?? null,
      endedAt: t.endedAt ?? null,
      updatedAt: t.updatedAt ?? null,
      createdAt: t.createdAt,
    })
    .run();
  return { ...t, laneId };
}

export function getTask(id: string): Task | null {
  const row = getDb().select().from(tasks).where(eq(tasks.id, id)).get();
  return row ? toTask(row) : null;
}

export function listTasksByTicket(ticketId: string): Task[] {
  return getDb().select().from(tasks).where(eq(tasks.ticketId, ticketId)).all().map(toTask);
}

export interface TaskPatch {
  state?: TaskState;
  laneId?: string;
  agentId?: string | null;
  worktreePath?: string | null;
  branch?: string | null;
  retryCount?: number;
  attempt?: number;
  lastError?: string | null;
  lastErrorSignature?: string | null;
  startedAt?: number | null;
  endedAt?: number | null;
}

export function updateTask(id: string, patch: TaskPatch): void {
  getDb()
    .update(tasks)
    .set({ ...patch, updatedAt: Date.now() })
    .where(eq(tasks.id, id))
    .run();
}

/**
 * Atomic single-flight claim: transition `from → to` only if the row is currently in `from`.
 * Returns true iff THIS caller won the claim (changed exactly one row). The conditional UPDATE
 * is atomic in SQLite, so concurrent callers cannot both win.
 */
export function claimTaskState(
  id: string,
  from: TaskState,
  to: TaskState,
  patch: TaskPatch = {},
): boolean {
  const res = getDb()
    .update(tasks)
    .set({ ...patch, state: to, updatedAt: Date.now() })
    .where(and(eq(tasks.id, id), eq(tasks.state, from)))
    .run();
  return res.changes === 1;
}
