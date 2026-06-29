// Data access for `task_events` (Phase 1) — append-only audit/streaming log. `seq` is a
// per-ticket monotonic counter; callers should append inside the per-ticket serialized section
// (engine.advance) so seq is gap-free. NEVER replayed to re-execute (commentary only).
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import type { TaskEvent } from '@thaloslab/shared';
import { getDb } from '../db';
import { taskEvents } from '../schema';

type Row = typeof taskEvents.$inferSelect;

function toEvent(row: Row): TaskEvent {
  return {
    id: row.id,
    ticketId: row.ticketId,
    taskId: row.taskId ?? undefined,
    gateId: row.gateId ?? undefined,
    type: row.type,
    payload: row.payloadJson ? JSON.parse(row.payloadJson) : undefined,
    seq: row.seq,
    createdAt: row.createdAt,
  };
}

export interface AppendEventInput {
  id: string;
  ticketId: string;
  taskId?: string;
  gateId?: string;
  type: string;
  payload?: unknown;
  createdAt: number;
}

export function appendTaskEvent(input: AppendEventInput): TaskEvent {
  const row = getDb()
    .select({ maxSeq: sql<number>`COALESCE(MAX(${taskEvents.seq}), 0)` })
    .from(taskEvents)
    .where(eq(taskEvents.ticketId, input.ticketId))
    .get();
  const seq = (row?.maxSeq ?? 0) + 1;

  getDb()
    .insert(taskEvents)
    .values({
      id: input.id,
      ticketId: input.ticketId,
      taskId: input.taskId ?? null,
      gateId: input.gateId ?? null,
      type: input.type,
      payloadJson: input.payload === undefined ? null : JSON.stringify(input.payload),
      seq,
      createdAt: input.createdAt,
    })
    .run();

  return { ...input, payload: input.payload, seq };
}

/** Events for a ticket after `afterSeq` (reconnect/gap fetch); pass 0 for all. */
export function eventsSince(ticketId: string, afterSeq = 0): TaskEvent[] {
  return getDb()
    .select()
    .from(taskEvents)
    .where(and(eq(taskEvents.ticketId, ticketId), gt(taskEvents.seq, afterSeq)))
    .orderBy(asc(taskEvents.seq))
    .all()
    .map(toEvent);
}
