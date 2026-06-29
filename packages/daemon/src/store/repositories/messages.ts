// Data access for `messages` (Phase 1) — the persisted orchestrator conversation stream.
import { asc, eq } from 'drizzle-orm';
import type { OrchestratorMessage } from '@thaloslab/shared';
import { getDb } from '../db';
import { messages } from '../schema';

type Row = typeof messages.$inferSelect;

export interface StoredMessage {
  id: string;
  projectId: string;
  ticketId?: string;
  message: OrchestratorMessage;
  createdAt: number;
}

function toStored(row: Row): StoredMessage {
  return {
    id: row.id,
    projectId: row.projectId,
    ticketId: row.ticketId ?? undefined,
    message: JSON.parse(row.payloadJson) as OrchestratorMessage,
    createdAt: row.createdAt,
  };
}

export function insertMessage(m: StoredMessage): StoredMessage {
  getDb()
    .insert(messages)
    .values({
      id: m.id,
      projectId: m.projectId,
      ticketId: m.ticketId ?? null,
      type: m.message.type,
      payloadJson: JSON.stringify(m.message),
      createdAt: m.createdAt,
    })
    .run();
  return m;
}

export function listMessagesByTicket(ticketId: string): StoredMessage[] {
  return getDb()
    .select()
    .from(messages)
    .where(eq(messages.ticketId, ticketId))
    .orderBy(asc(messages.createdAt))
    .all()
    .map(toStored);
}

export function listMessagesByProject(projectId: string): StoredMessage[] {
  return getDb()
    .select()
    .from(messages)
    .where(eq(messages.projectId, projectId))
    .orderBy(asc(messages.createdAt))
    .all()
    .map(toStored);
}
