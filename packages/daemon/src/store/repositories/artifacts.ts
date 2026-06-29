// Data access for `artifacts` (Phase 1). Pointer records; bytes live under the repo's `.thalos/`.
import { eq } from 'drizzle-orm';
import type { ArtifactKind, ArtifactRef } from '@thaloslab/shared';
import { getDb } from '../db';
import { artifacts } from '../schema';

type Row = typeof artifacts.$inferSelect;

export interface ArtifactRecord extends ArtifactRef {
  ticketId: string;
  taskId?: string;
  createdAt: number;
}

function toRecord(row: Row): ArtifactRecord {
  return {
    id: row.id,
    ticketId: row.ticketId,
    taskId: row.taskId ?? undefined,
    kind: row.kind as ArtifactKind,
    path: row.path,
    summary: row.summary ?? undefined,
    createdAt: row.createdAt,
  };
}

export function insertArtifact(a: ArtifactRecord): ArtifactRecord {
  getDb()
    .insert(artifacts)
    .values({
      id: a.id,
      ticketId: a.ticketId,
      taskId: a.taskId ?? null,
      kind: a.kind,
      path: a.path,
      summary: a.summary ?? null,
      createdAt: a.createdAt,
    })
    .run();
  return a;
}

export function listArtifactsByTicket(ticketId: string): ArtifactRecord[] {
  return getDb()
    .select()
    .from(artifacts)
    .where(eq(artifacts.ticketId, ticketId))
    .all()
    .map(toRecord);
}
