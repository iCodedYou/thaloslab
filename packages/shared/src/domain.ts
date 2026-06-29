// Core domain entities (SPEC §6, §7, §10). Mirrors the SQLite schema and the
// versioned `.thalos/agents/*.json` configs.
import type { ArtifactKind, ExecutionMode, NetworkPosture, ProviderId, TaskType } from './core.js';

// ---- Agents (SPEC §6) ----

export type AgentRole =
  | 'orchestrator'
  | 'architect'
  | 'engineer'
  | 'reviewer'
  | 'test-author'
  | 'security-auditor'
  | 'integrator'
  | 'custom';

export type AuthorityLevel =
  | 'L0-observe' // read-only; produces reports/recommendations, never writes
  | 'L1-propose' // writes artifacts/diffs but never applies; everything gated
  | 'L2-execute-gated' // applies changes within its own worktree; gated + human approval
  | 'L3-execute-autonomous'; // applies + may merge within policy (autonomous build loop only)

export type PathScope = 'own-worktree' | 'project-repo' | 'machine';

export interface AccessLevel {
  pathScope: PathScope;
  network: NetworkPosture;
  networkAllowlist?: string[];
}

/** A concrete provider, `auto` routing, or a pooled collab provider. */
export type AgentProvider = ProviderId | 'auto' | `collab:${string}`;

export type AgentStatus = 'active' | 'inactive';
export type AgentCreatedBy = 'default' | 'orchestrator' | 'user';

export interface AgentConfig {
  id: string;
  projectId: string;
  role: AgentRole;
  name: string;
  provider: AgentProvider;
  model?: string;
  systemPrompt: string;
  authority: AuthorityLevel;
  access: AccessLevel;
  restrictedCommands: string[];
  status: AgentStatus;
  concurrency?: number;
  retryCap?: number;
  createdBy: AgentCreatedBy;
}

// ---- Projects (SPEC §10) ----

export type ProjectOrigin = 'scratch' | 'imported';
export type ProjectPhase = 'bootstrapping' | 'maintenance';

export interface Project {
  id: string;
  name: string;
  repoPath: string;
  githubUrl?: string;
  origin: ProjectOrigin;
  phase: ProjectPhase;
  orchestratorProvider: ProviderId;
  routingPolicy?: Record<string, unknown>;
  createdAt: number;
}

// ---- Tickets (SPEC §10) ----

export type TicketStatus =
  | 'queued'
  | 'running'
  | 'blocked'
  | 'preview-complete' // preview rendered the plan/DAG and stopped without executing
  | 'done'
  | 'failed'
  | 'escalated'
  | 'aborted';

export interface Ticket {
  id: string;
  projectId: string;
  title: string;
  body?: string;
  taskType?: TaskType;
  mutating?: boolean;
  blastRadius?: string[];
  workflowId?: string;
  status: TicketStatus;
  mode: ExecutionMode;
  createdAt: number;
}

// ---- Detected providers (SPEC §10 providers table + §12 connected-agents view) ----

export type ProviderKind = 'local' | 'collab';

export interface DetectedProvider {
  id: ProviderId;
  kind: ProviderKind;
  displayName: string;
  installed: boolean;
  authenticated: boolean;
  version?: string;
  /** Epoch ms of the last detection probe. */
  lastChecked: number;
}

// ---- Workflow templates (SPEC §7) — data, not code ----

export interface StageDef {
  id: string;
  role: AgentRole | 'custom';
  customRoleHint?: string; // for orchestrator-synthesized agents
  parallelizable?: boolean; // engineers fan out here
  loop?: { until: 'gates-green'; retryCap: number }; // the inner build loop
  produces: ArtifactKind[];
  dependsOn: string[]; // stage ids
}

export type GateCheck =
  | 'build'
  | 'typecheck'
  | 'lint'
  | 'unit'
  | 'integration'
  | 'e2e'
  | 'benchmark'
  | 'a11y'
  | 'visual-diff';

export interface GateDef {
  id: string;
  kind: 'automated' | 'human';
  after: string; // stage id
  checks?: GateCheck[]; // automated
  prompt?: string; // human: what the user is approving
  blocking: boolean;
}

export interface WorkflowTemplate {
  id: string;
  label: string;
  appliesTo: TaskType[];
  mutating: boolean;
  stages: StageDef[];
  gates: GateDef[];
}

// ---- Workflow engine runtime (SPEC §7) — task-graph state machine ----

/** Task-graph node states (SPEC §7): pending → running → (review → fixing)* → … → terminal. */
export type TaskState =
  | 'pending'
  | 'running'
  | 'review'
  | 'fixing'
  | 'blocked-on-human'
  | 'passed'
  | 'failed'
  | 'escalated'
  | 'done';

export type TaskKind = 'stage' | 'gate';

/** Automated gates resolve passed/failed; human gates resolve via `decision`. */
export type GateStatus = 'pending' | 'passed' | 'failed' | 'resolved';
export type GateDecision = 'approve' | 'reject' | 'request-changes';

export type RunStatus = 'running' | 'ok' | 'error' | 'timeout' | 'interrupted' | 'stubbed';

/** Append-only audit/streaming event (commentary only — never replayed to re-execute). */
export interface TaskEvent {
  id: string;
  ticketId: string;
  taskId?: string;
  gateId?: string;
  type: string;
  payload?: unknown;
  /** Per-ticket monotonic counter for reconnect/gap-fetch. */
  seq: number;
  createdAt: number;
}

/** Resolved once from ExecutionMode; the only thing side-effecting boundaries check. */
export interface EngineCapabilities {
  invokeAgents: boolean;
  mutateRepo: boolean;
}

/** A task-graph node instance (a row in `tasks`), with `dependsOn` parsed. */
export interface Task {
  id: string;
  ticketId: string;
  stageId: string;
  kind: TaskKind;
  agentId?: string;
  dependsOn: string[];
  worktreePath?: string;
  branch?: string;
  state: TaskState;
  retryCount: number;
  attempt: number;
  lastError?: string;
  lastErrorSignature?: string;
  startedAt?: number;
  endedAt?: number;
  updatedAt?: number;
  createdAt: number;
}

/** One provider invocation (a row in `runs`). */
export interface Run {
  id: string;
  taskId: string;
  agentId?: string;
  provider: string;
  requestedProvider?: string;
  prompt?: string;
  output?: string;
  changedFiles?: string[];
  errorSignature?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  durationMs?: number;
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
}

/** A gate instance (a row in `gates`) — automated (passed/failed) or human (decision). */
export interface Gate {
  id: string;
  ticketId: string;
  taskId?: string;
  kind: 'automated' | 'human';
  title?: string;
  prompt?: string;
  checks?: GateCheck[];
  artifactRefId?: string;
  status: GateStatus;
  decision?: GateDecision;
  comment?: string;
  resolvedBy?: string;
  resolvedAt?: number;
  createdAt?: number;
}
