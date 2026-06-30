// DB-FREE adapter access — the leaf adapter list + mode-aware resolution, with NO `store/*` imports.
// This is what lets the collab peer-agent (which has no projects/tickets DB, no lockfile) run a provider
// without dragging in the daemon's database. registry.ts re-exports these and layers the DB-touching
// `routerCtx`/`detectAll` on top.
import type { ExecutionMode, ProviderAdapter, ProviderId } from '@thaloslab/shared';
import { claudeAdapter } from './claude';
import { codexAdapter } from './codex';
import { geminiAdapter } from './gemini';
import { mockFor } from './mock';

// Registration order is the default preference order (claude > codex > gemini), per-project overridable.
const adapters: ProviderAdapter[] = [claudeAdapter, codexAdapter, geminiAdapter];

export function getAdapters(): ProviderAdapter[] {
  return adapters;
}

export function getAdapter(id: ProviderId): ProviderAdapter | undefined {
  return adapters.find((a) => a.id === id);
}

/**
 * Resolve the adapter for a provider in a given mode. In `--mock` EVERY invocation uses the scripted
 * mock adapter (no tokens) — the single switch that keeps mock runs deterministic, host or peer.
 */
export function adapterFor(providerId: ProviderId, mode: ExecutionMode): ProviderAdapter {
  if (mode === 'mock') return mockFor(providerId);
  const adapter = getAdapter(providerId);
  if (!adapter) throw new Error(`no provider adapter for "${providerId}"`);
  return adapter;
}
