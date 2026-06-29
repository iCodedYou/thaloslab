// Data access for `tickets` (Phase 1).
import { desc, eq } from 'drizzle-orm';
import type { ExecutionMode, TaskType, Ticket, TicketStatus } from '@thaloslab/shared';
import { getDb } from '../db';
import { tickets } from '../schema';

type Row = typeof tickets.$inferSelect;

function toTicket(row: Row): Ticket {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    body: row.body ?? undefined,
    taskType: (row.taskType as TaskType | null) ?? undefined,
    mutating: row.mutating == null ? undefined : row.mutating === 1,
    blastRadius: row.blastRadiusJson ? (JSON.parse(row.blastRadiusJson) as string[]) : undefined,
    workflowId: row.workflowId ?? undefined,
    status: row.status as TicketStatus,
    mode: row.mode,
    createdAt: row.createdAt,
  };
}

export function insertTicket(t: Ticket): Ticket {
  getDb()
    .insert(tickets)
    .values({
      id: t.id,
      projectId: t.projectId,
      title: t.title,
      body: t.body ?? null,
      taskType: t.taskType ?? null,
      mutating: t.mutating == null ? null : t.mutating ? 1 : 0,
      blastRadiusJson: t.blastRadius ? JSON.stringify(t.blastRadius) : null,
      workflowId: t.workflowId ?? null,
      status: t.status,
      mode: t.mode,
      createdAt: t.createdAt,
    })
    .run();
  return t;
}

export function getTicket(id: string): Ticket | null {
  const row = getDb().select().from(tickets).where(eq(tickets.id, id)).get();
  return row ? toTicket(row) : null;
}

export function listTickets(projectId?: string): Ticket[] {
  const q = getDb().select().from(tickets).orderBy(desc(tickets.createdAt));
  const rows = projectId ? q.where(eq(tickets.projectId, projectId)).all() : q.all();
  return rows.map(toTicket);
}

export function listTicketsByStatus(statuses: TicketStatus[]): Ticket[] {
  // Small set; filter in JS to keep the query simple.
  return getDb()
    .select()
    .from(tickets)
    .all()
    .map(toTicket)
    .filter((t) => statuses.includes(t.status));
}

export function setTicketStatus(id: string, status: TicketStatus): void {
  getDb().update(tickets).set({ status }).where(eq(tickets.id, id)).run();
}

export interface TicketTriagePatch {
  taskType?: TaskType;
  mutating?: boolean;
  blastRadius?: string[];
  workflowId?: string;
  mode?: ExecutionMode;
}

export function updateTicketTriage(id: string, patch: TicketTriagePatch): void {
  getDb()
    .update(tickets)
    .set({
      ...(patch.taskType !== undefined ? { taskType: patch.taskType } : {}),
      ...(patch.mutating !== undefined ? { mutating: patch.mutating ? 1 : 0 } : {}),
      ...(patch.blastRadius !== undefined
        ? { blastRadiusJson: JSON.stringify(patch.blastRadius) }
        : {}),
      ...(patch.workflowId !== undefined ? { workflowId: patch.workflowId } : {}),
      ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
    })
    .where(eq(tickets.id, id))
    .run();
}
