// Data access for `gates` (Phase 1). Automated gates resolve passed/failed; human gates park
// pending and resolve via a decision (honoring the ws `gate.resolve` contract).
import { and, eq } from 'drizzle-orm';
import type { Gate, GateCheck, GateDecision, GateStatus } from '@thaloslab/shared';
import { getDb } from '../db';
import { gates } from '../schema';

type Row = typeof gates.$inferSelect;

function toGate(row: Row): Gate {
  return {
    id: row.id,
    ticketId: row.ticketId,
    taskId: row.taskId ?? undefined,
    kind: row.kind as 'automated' | 'human',
    title: row.title ?? undefined,
    prompt: row.prompt ?? undefined,
    checks: row.checksJson ? (JSON.parse(row.checksJson) as GateCheck[]) : undefined,
    artifactRefId: row.artifactRefId ?? undefined,
    status: row.status as GateStatus,
    decision: (row.decision as GateDecision | null) ?? undefined,
    comment: row.comment ?? undefined,
    resolvedBy: row.resolvedBy ?? undefined,
    resolvedAt: row.resolvedAt ?? undefined,
    createdAt: row.createdAt ?? undefined,
  };
}

export function insertGate(g: Gate): Gate {
  getDb()
    .insert(gates)
    .values({
      id: g.id,
      ticketId: g.ticketId,
      taskId: g.taskId ?? null,
      kind: g.kind,
      title: g.title ?? null,
      prompt: g.prompt ?? null,
      checksJson: g.checks ? JSON.stringify(g.checks) : null,
      artifactRefId: g.artifactRefId ?? null,
      status: g.status,
      decision: g.decision ?? null,
      comment: g.comment ?? null,
      resolvedBy: g.resolvedBy ?? null,
      resolvedAt: g.resolvedAt ?? null,
      createdAt: g.createdAt ?? Date.now(),
    })
    .run();
  return g;
}

export function getGate(id: string): Gate | null {
  const row = getDb().select().from(gates).where(eq(gates.id, id)).get();
  return row ? toGate(row) : null;
}

export function listGatesByTicket(ticketId: string): Gate[] {
  return getDb().select().from(gates).where(eq(gates.ticketId, ticketId)).all().map(toGate);
}

export function setGateStatus(id: string, status: GateStatus): void {
  getDb().update(gates).set({ status }).where(eq(gates.id, id)).run();
}

/** Resolve a human gate. Atomic: only resolves a still-`pending` gate (returns whether it won). */
export function resolveGate(
  id: string,
  decision: GateDecision,
  resolvedBy: string,
  comment?: string,
  now = Date.now(),
): boolean {
  const res = getDb()
    .update(gates)
    .set({ status: 'resolved', decision, comment: comment ?? null, resolvedBy, resolvedAt: now })
    .where(and(eq(gates.id, id), eq(gates.status, 'pending')))
    .run();
  return res.changes === 1;
}
