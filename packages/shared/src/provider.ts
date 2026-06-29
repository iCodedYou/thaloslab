// Provider abstraction layer types (SPEC §5). The adapter is the only place
// vendor-specific knowledge lives; the rest of the system speaks these types.
import type { ArtifactRef, ExecutionMode, NetworkPosture, ProviderId } from './core.js';

export interface ProviderCapabilities {
  canEditFiles: boolean; // agentic file edits in a working dir
  canRunCommands: boolean; // can execute shell commands
  streaming: boolean; // streams incremental output
  structuredOutput: boolean; // can emit JSON we can parse
}

export interface InvokeOptions {
  prompt: string; // the constructed task brief / system+user content
  systemPrompt?: string; // role system prompt
  cwd: string; // the worktree this invocation is scoped to
  allowedTools?: string[]; // maps to the CLI's own permission flags
  deniedCommands?: string[]; // restricted-commands enforcement
  network?: NetworkPosture;
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

export interface ProviderAdapter {
  id: ProviderId;
  displayName: string;
  /** Zero-cost probe (never spends tokens). */
  detect(): Promise<DetectResult>;
  capabilities(): ProviderCapabilities;
  /** Streams events; the final event carries the InvokeResult. */
  invoke(opts: InvokeOptions): AsyncIterable<ProviderEvent>;
}
