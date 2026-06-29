// EventBus — the engine's single seam to the outside (WS hub, tests). Each emit is persisted to
// the append-only task_events log (durable, gap-free per ticket) THEN fanned out to subscribers
// (best-effort, lossy). The engine never imports Fastify; the Hub subscribes here.
import { appendTaskEvent } from '../store/repositories/task-events';
import { genId } from '../util/id';

export interface EngineEvent {
  ticketId: string;
  type: string;
  taskId?: string;
  gateId?: string;
  payload?: unknown;
  /** Assigned by emit() from the persisted task_events row. */
  seq?: number;
}

export type EngineEventListener = (event: EngineEvent) => void;

export class EventBus {
  private readonly listeners = new Set<EngineEventListener>();

  subscribe(listener: EngineEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: EngineEvent): void {
    const stored = appendTaskEvent({
      id: genId('ev'),
      ticketId: event.ticketId,
      taskId: event.taskId,
      gateId: event.gateId,
      type: event.type,
      payload: event.payload,
      createdAt: Date.now(),
    });
    const withSeq: EngineEvent = { ...event, seq: stored.seq };
    for (const listener of this.listeners) {
      try {
        listener(withSeq);
      } catch {
        // A subscriber error (e.g. a dead socket) must never break the engine.
      }
    }
  }
}
