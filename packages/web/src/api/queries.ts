import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AgentConfig,
  AgentStatus,
  DetectedProvider,
  ExecutionMode,
  Gate,
  GateDecision,
  OrchestratorMessage,
  Project,
  Task,
  Ticket,
} from '@thaloslab/shared';
import { apiGet, apiPatch, apiPost } from './client';

export function useProjects() {
  return useQuery({ queryKey: ['projects'], queryFn: () => apiGet<Project[]>('/api/projects') });
}

export function useProviders() {
  return useQuery({
    queryKey: ['providers'],
    queryFn: () => apiGet<DetectedProvider[]>('/api/providers'),
  });
}

export interface ArtifactRecord {
  id: string;
  kind: string;
  path: string;
  summary?: string;
}
export interface StoredMessage {
  id: string;
  message: OrchestratorMessage;
  createdAt: number;
}
export interface TicketDetail {
  ticket: Ticket;
  tasks: Task[];
  gates: Gate[];
  artifacts: ArtifactRecord[];
  messages: StoredMessage[];
}

const TERMINAL: ReadonlySet<string> = new Set([
  'done',
  'failed',
  'escalated',
  'aborted',
  'preview-complete',
]);

export function useTickets(projectId?: string) {
  return useQuery({
    queryKey: ['tickets', projectId],
    queryFn: () => apiGet<Ticket[]>(`/api/tickets${projectId ? `?projectId=${projectId}` : ''}`),
    refetchInterval: 2000,
  });
}

export function useTicket(id?: string) {
  return useQuery({
    queryKey: ['ticket', id],
    queryFn: () => apiGet<TicketDetail>(`/api/tickets/${id}`),
    enabled: Boolean(id),
    // Light polling while the ticket is active (the WS hook also invalidates on events).
    refetchInterval: (q) => (TERMINAL.has(q.state.data?.ticket.status ?? '') ? false : 1500),
  });
}

export function useCreateTicket() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { projectId: string; title: string; body?: string; mode: ExecutionMode }) =>
      apiPost<{ ticket: Ticket }>('/api/tickets', body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['tickets'] }),
  });
}

export function useAgents(projectId?: string) {
  return useQuery({
    queryKey: ['agents', projectId],
    queryFn: () => apiGet<AgentConfig[]>(`/api/agents?projectId=${projectId}`),
    enabled: Boolean(projectId),
  });
}

export function useUpdateAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      id: string;
      patch: { name?: string; systemPrompt?: string; status?: AgentStatus };
    }) => apiPatch<{ agent: AgentConfig }>(`/api/agents/${args.id}`, args.patch),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['agents'] }),
  });
}

// ---- Collab (SPEC §11) ----

export interface CollabPeerView {
  peerId: string;
  vendors: string[];
  sandboxOk: boolean;
  joinRequested: boolean;
  admitted: boolean;
  revoked: boolean;
  routable: boolean;
}
export interface CollabState {
  active: boolean;
  peers: CollabPeerView[];
}
export interface PersistedManifest {
  runId: string;
  peerId: string;
  createdAt: number;
  entries: { path: string; sha256: string; bytes: number }[];
  excluded: string[];
}

export function useCollab() {
  return useQuery({
    queryKey: ['collab'],
    queryFn: () => apiGet<CollabState>('/api/collab'),
    refetchInterval: 3000,
  });
}

export function useCollabManifests(projectId?: string) {
  return useQuery({
    queryKey: ['collab-manifests', projectId],
    queryFn: () => apiGet<PersistedManifest[]>(`/api/collab/${projectId}/manifests`),
    enabled: Boolean(projectId),
    refetchInterval: 4000,
  });
}

/** POST a collab control action (enable/disable/admit/revoke) and refresh the state. */
export function useCollabAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (path: string) => apiPost<CollabState>(path, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['collab'] }),
  });
}

export function useResolveGate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { gateId: string; decision: GateDecision; comment?: string }) =>
      apiPost(`/api/gates/${args.gateId}/resolve`, {
        decision: args.decision,
        comment: args.comment,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['ticket'] });
      void qc.invalidateQueries({ queryKey: ['tickets'] });
    },
  });
}
