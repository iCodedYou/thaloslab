// WebSocket event contracts between daemon and web (SPEC §17). Phase 0 ships only the
// transport + types; most events fire from later phases.
import type { ProviderId } from './core.js';
import type { OrchestratorMessage } from './messages.js';
import type { ProviderEvent } from './provider.js';

/** Server → client events (live stream). */
export interface ServerToClientEvents {
  'orchestrator.message': { message: OrchestratorMessage };
  'agent.output': { runId: string; taskId: string; event: ProviderEvent };
  'task.state': { taskId: string; state: string };
  'gate.pending': { gateId: string; ticketId: string; title?: string };
  'run.usage': { runId: string; inputTokens?: number; outputTokens?: number; costUsd?: number };
  'provider.status': { providerId: ProviderId; installed: boolean; authenticated: boolean };
  'collab.peer': { peerId: string; status: string; sharedProviders: string[] };
}

/** Client → server events. */
export interface ClientToServerEvents {
  'ticket.create': { projectId: string; title: string; body?: string };
  'gate.resolve': {
    gateId: string;
    decision: 'approve' | 'reject' | 'request-changes';
    comment?: string;
  };
  'ticket.abort': { ticketId: string };
  'orchestrator.message': { projectId: string; content: string };
}

export type ServerEventName = keyof ServerToClientEvents;
export type ClientEventName = keyof ClientToServerEvents;

/** A tagged server event suitable for sending over the wire. */
export type ServerEnvelope = {
  [K in ServerEventName]: { event: K; payload: ServerToClientEvents[K] };
}[ServerEventName];

/** A tagged client event suitable for sending over the wire. */
export type ClientEnvelope = {
  [K in ClientEventName]: { event: K; payload: ClientToServerEvents[K] };
}[ClientEventName];
