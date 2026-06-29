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

export type TicketStatus = 'queued' | 'running' | 'blocked' | 'done' | 'failed' | 'aborted';

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
