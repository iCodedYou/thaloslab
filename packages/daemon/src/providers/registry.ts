// Adapter registry + detection sweep. detectAll() probes every adapter (zero token spend) and
// upserts results into the providers table. Phase 1 adds mode-aware routing: --mock returns the
// scripted mock adapter (zero tokens) for every role; --live/--preview return the real adapter.
import type {
  DetectedProvider,
  ExecutionMode,
  ProviderAdapter,
  ProviderId,
  SandboxCapability,
} from '@thaloslab/shared';
import { getProject } from '../store/repositories/projects';
import { listProviders, upsertProvider } from '../store/repositories/providers';
import { claudeAdapter } from './claude';
import { codexAdapter } from './codex';
import { geminiAdapter } from './gemini';
import { mockFor } from './mock';
import { type RouterCtx, sandboxSatisfies } from './router';

// Registration order is the default preference order (claude > codex > gemini), per-project overridable.
const adapters: ProviderAdapter[] = [claudeAdapter, codexAdapter, geminiAdapter];

export function getAdapters(): ProviderAdapter[] {
  return adapters;
}

export function getAdapter(id: ProviderId): ProviderAdapter | undefined {
  return adapters.find((a) => a.id === id);
}

/**
 * Resolve the adapter for a role's provider in a given mode. In `--mock` EVERY invocation uses the
 * scripted mock adapter (no tokens) — this is the single switch that keeps mock runs deterministic.
 */
export function adapterFor(providerId: ProviderId, mode: ExecutionMode): ProviderAdapter {
  // In --mock every invocation uses a PROVIDER-TAGGED mock (deterministic, zero tokens). The tag
  // lets a cross-provider mock run be told apart per provider while staying scripted.
  if (mode === 'mock') return mockFor(providerId);
  const adapter = getAdapter(providerId);
  if (!adapter) throw new Error(`no provider adapter for "${providerId}"`);
  return adapter;
}

/**
 * Build the router context from live state: detected providers (availability), the project's
 * preference order (defaults to detection/registration order), and the per-provider `enforce` →
 * `unmet` filter (minus any constraints the policy marked `relaxable`, minus any constraint a VERIFIED
 * sandbox makes moot for THIS invocation — Phase 5). `sandboxCaps` MUST already be the trusted set
 * (empty unless the sandbox that WILL wrap this run passed its self-test); an unverified jail relaxes
 * nothing, so the router can never un-pin a provider for a run that won't actually be confined.
 */
export function routerCtx(projectId?: string, sandboxCaps: SandboxCapability[] = []): RouterCtx {
  const configured = projectId
    ? (getProject(projectId)?.routingPolicy?.preferenceOrder as ProviderId[] | undefined)
    : undefined;
  return {
    availability: listProviders(),
    preferenceOrder: configured ?? adapters.map((a) => a.id),
    unmetFor: (id, policy) => {
      const adapter = getAdapter(id);
      if (!adapter) return ['no-adapter'];
      const satisfied = sandboxSatisfies(policy, sandboxCaps);
      return adapter
        .enforce(policy)
        .unmet.filter((u) => !policy.relaxable?.includes(u))
        .filter((u) => !satisfied.includes(u));
    },
  };
}

export async function detectAll(): Promise<DetectedProvider[]> {
  const now = Date.now();
  const results: DetectedProvider[] = [];
  for (const adapter of adapters) {
    const probe = await adapter.detect();
    const provider: DetectedProvider = {
      id: adapter.id,
      kind: 'local',
      displayName: adapter.displayName,
      installed: probe.installed,
      authenticated: probe.authenticated,
      version: probe.version,
      lastChecked: now,
    };
    upsertProvider(provider);
    results.push(provider);
  }
  return results;
}
