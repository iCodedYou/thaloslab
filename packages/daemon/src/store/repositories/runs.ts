// Data access for `runs` (Phase 1). The doom-loop detector reads the last N runs of a task.
import { desc, eq } from 'drizzle-orm';
import type { Run, RunStatus } from '@thaloslab/shared';
import { getDb } from '../db';
import { runs } from '../schema';

type Row = typeof runs.$inferSelect;

function toRun(row: Row): Run {
  return {
    id: row.id,
    taskId: row.taskId,
    agentId: row.agentId ?? undefined,
    provider: row.provider,
    requestedProvider: row.requestedProvider ?? undefined,
    prompt: row.prompt ?? undefined,
    output: row.output ?? undefined,
    changedFiles: row.changedFilesJson ? (JSON.parse(row.changedFilesJson) as string[]) : undefined,
    errorSignature: row.errorSignature ?? undefined,
    inputTokens: row.inputTokens ?? undefined,
    outputTokens: row.outputTokens ?? undefined,
    costUsd: row.costUsd ?? undefined,
    durationMs: row.durationMs ?? undefined,
    status: row.status as RunStatus,
    startedAt: row.startedAt,
    endedAt: row.endedAt ?? undefined,
  };
}

export function insertRun(r: Run): Run {
  getDb()
    .insert(runs)
    .values({
      id: r.id,
      taskId: r.taskId,
      agentId: r.agentId ?? null,
      provider: r.provider,
      requestedProvider: r.requestedProvider ?? null,
      prompt: r.prompt ?? null,
      output: r.output ?? null,
      changedFilesJson: r.changedFiles ? JSON.stringify(r.changedFiles) : null,
      errorSignature: r.errorSignature ?? null,
      inputTokens: r.inputTokens ?? null,
      outputTokens: r.outputTokens ?? null,
      costUsd: r.costUsd ?? null,
      durationMs: r.durationMs ?? null,
      status: r.status,
      startedAt: r.startedAt,
      endedAt: r.endedAt ?? null,
    })
    .run();
  return r;
}

export interface RunPatch {
  output?: string | null;
  changedFiles?: string[] | null;
  errorSignature?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number | null;
  durationMs?: number | null;
  status?: RunStatus;
  endedAt?: number | null;
}

export function updateRun(id: string, patch: RunPatch): void {
  const { changedFiles, ...rest } = patch;
  getDb()
    .update(runs)
    .set({
      ...rest,
      ...(changedFiles !== undefined
        ? { changedFilesJson: changedFiles ? JSON.stringify(changedFiles) : null }
        : {}),
    })
    .where(eq(runs.id, id))
    .run();
}

/** Most recent runs for a task, newest first (doom-loop reads the last 2–3). */
export function recentRunsForTask(taskId: string, limit = 5): Run[] {
  return getDb()
    .select()
    .from(runs)
    .where(eq(runs.taskId, taskId))
    .orderBy(desc(runs.startedAt))
    .limit(limit)
    .all()
    .map(toRun);
}

/** Reap runs left `running` by a crash (called on boot). Returns affected ids. */
export function interruptRunningRuns(now: number): string[] {
  const running = getDb().select().from(runs).where(eq(runs.status, 'running')).all();
  for (const r of running) {
    getDb()
      .update(runs)
      .set({ status: 'interrupted', endedAt: now })
      .where(eq(runs.id, r.id))
      .run();
  }
  return running.map((r) => r.id);
}
