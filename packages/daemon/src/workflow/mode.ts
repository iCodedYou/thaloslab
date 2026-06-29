// Resolve ExecutionMode into EngineCapabilities once (DECISIONS #3/#12). Only side-effecting
// boundaries (worktree creation, agent invocation) check these; nothing branches on raw mode.
import type { EngineCapabilities, ExecutionMode } from '@thaloslab/shared';

export function capabilitiesFor(mode: ExecutionMode): EngineCapabilities {
  switch (mode) {
    case 'live':
      return { invokeAgents: true, mutateRepo: true };
    case 'mock':
      return { invokeAgents: true, mutateRepo: true };
    case 'preview':
      return { invokeAgents: false, mutateRepo: false };
  }
}
