// Provider abstraction layer types (SPEC §5). The adapter is the only place
// vendor-specific knowledge lives; the rest of the system speaks these types.
import type { ArtifactRef, ExecutionMode, NetworkPosture, ProviderId } from './core.js';
import type { PathScope } from './domain.js';

export interface ProviderCapabilities {
  canEditFiles: boolean; // agentic file edits in a working dir
  canRunCommands: boolean; // can execute shell commands
  streaming: boolean; // streams incremental output
  structuredOutput: boolean; // can emit JSON we can parse
}

/**
 * NEUTRAL permission policy (SPEC §5, Phase 3). The engine speaks this; each adapter's `enforce`
 * translates it to that CLI's actual mechanism (Claude per-tool allowlist, Codex sandbox+approval,
 * Gemini approval+tool config). A constraint a provider cannot express becomes `unmet` → the router
 * fails closed. No constraint may silently map to "unenforced".
 */
export interface ToolPolicy {
  canRead: boolean;
  canWrite: boolean; // file edits in cwd
  canExecCommands: boolean; // run shell at all
  commandAllowlist?: string[]; // neutral patterns, e.g. ['git *','pnpm *','node *']
  commandDenylist?: string[]; // neutral, e.g. ['rm -rf *','curl *','wget *']
  network: NetworkPosture;
  networkAllowlist?: string[];
  pathScope: PathScope;
  /** Constraints intentionally relaxed (justified) — allowed but logged + surfaced, never silent. */
  relaxable?: string[];
}

export interface InvokeOptions {
  prompt: string; // the constructed task brief / system+user content
  systemPrompt?: string; // role system prompt
  cwd: string; // the worktree this invocation is scoped to
  policy: ToolPolicy; // neutral permission policy the adapter translates to its CLI
  model?: string; // specific model within the provider, if applicable
  timeoutMs?: number;
  mode: ExecutionMode;
}

export interface InvokeUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface InvokeResult {
  ok: boolean;
  output: string; // final text/answer
  artifacts: ArtifactRef[]; // files written (diffs, reports, plans)
  changedFiles: string[]; // paths modified in cwd
  usage?: InvokeUsage;
  raw: unknown; // provider-native response for debugging
}

/**
 * Result of a provider probe. CONTRACT: producing this must never spend tokens —
 * PATH/version probe + zero-cost auth check only (SPEC §5, DECISIONS #17).
 */
export interface DetectResult {
  installed: boolean;
  authenticated: boolean;
  version?: string;
}

/** Streamed during `invoke`; the final `result` event carries the InvokeResult. */
export type ProviderEvent =
  | { type: 'stdout'; chunk: string }
  | { type: 'stderr'; chunk: string }
  | { type: 'tool'; name: string; detail?: string }
  | { type: 'status'; status: string }
  | { type: 'result'; result: InvokeResult };

/** Result of translating a neutral ToolPolicy to a provider's CLI. Pure + zero-cost (no spawn). */
export interface EnforceResult {
  /** CLI flags `invoke` will pass to express the enforceable parts of the policy. */
  args: string[];
  /** Constraints this provider CANNOT express — non-empty ⇒ the router must fail closed. */
  unmet: string[];
}

export interface ProviderAdapter {
  id: ProviderId;
  displayName: string;
  /** Zero-cost probe (never spends tokens). */
  detect(): Promise<DetectResult>;
  capabilities(): ProviderCapabilities;
  /** Translate the neutral policy to this CLI's flags; declare what it CANNOT enforce. Pure. */
  enforce(policy: ToolPolicy): EnforceResult;
  /** Streams events; the final event carries the InvokeResult. */
  invoke(opts: InvokeOptions): AsyncIterable<ProviderEvent>;
}
