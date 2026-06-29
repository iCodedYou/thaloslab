// Primitive types shared across the whole system. Kept dependency-free so both
// `domain` and `provider` can import from here without import cycles.

/** An installed AI CLI backend. Extensible: new adapters add their own id. */
export type ProviderId = 'claude' | 'codex' | 'gemini' | string;

/** Execution mode for a run. Modes gate agent execution, not app operations (SPEC §3). */
export type ExecutionMode = 'preview' | 'live' | 'mock';

/** Network posture applied to an agent/provider invocation (SPEC §9, DECISIONS #7). */
export type NetworkPosture = 'none' | 'allowlist' | 'full';

/** Ticket classification axis set by triage (SPEC §7). */
export type TaskType =
  | 'bugfix'
  | 'feature'
  | 'redesign'
  | 'security-audit'
  | 'optimization'
  | 'refactor'
  | 'docs'
  | 'investigation';

/** Durable artifact kinds written under a project's `.thalos/artifacts/` (SPEC §7). */
export type ArtifactKind =
  | 'spec'
  | 'plan'
  | 'threat-model'
  | 'task-graph'
  | 'diff'
  | 'test-results'
  | 'review'
  | 'audit-report'
  | 'benchmark'
  | 'repro-test'
  | 'findings';

/** Pointer to an artifact; bytes live under the repo's `.thalos/`, indexed in the DB. */
export interface ArtifactRef {
  id: string;
  kind: ArtifactKind;
  /** Path relative to the project repo's `.thalos/` directory. */
  path: string;
  summary?: string;
}
