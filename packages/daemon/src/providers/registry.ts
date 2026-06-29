// Adapter registry + detection sweep. detectAll() probes every adapter (zero token spend) and
// upserts results into the providers table. Phase 1 adds mode-aware routing: --mock returns the
// scripted mock adapter (zero tokens) for every role; --live/--preview return the real adapter.
import type {
  DetectedProvider,
  ExecutionMode,
  ProviderAdapter,
  ProviderId,
} from '@thaloslab/shared';
import { getProject } from '../store/repositories/projects';
import { listProviders, upsertProvider } from '../store/repositories/providers';
import { claudeAdapter } from './claude';
import { mockAdapter } from './mock';
import type { RouterCtx } from './router';

const adapters: ProviderAdapter[] = [claudeAdapter];

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
  if (mode === 'mock') return mockAdapter;
  const adapter = getAdapter(providerId);
  if (!adapter) throw new Error(`no provider adapter for "${providerId}"`);
  return adapter;
}

/**
 * Build the router context from live state: detected providers (availability), the project's
 * preference order (defaults to detection/registration order), and the per-provider `enforce` →
 * `unmet` filter (minus any constraints the policy marked `relaxable`).
 */
export function routerCtx(projectId?: string): RouterCtx {
  const configured = projectId
    ? (getProject(projectId)?.routingPolicy?.preferenceOrder as ProviderId[] | undefined)
    : undefined;
  return {
    availability: listProviders(),
    preferenceOrder: configured ?? adapters.map((a) => a.id),
    unmetFor: (id, policy) => {
      const adapter = getAdapter(id);
      if (!adapter) return ['no-adapter'];
      return adapter.enforce(policy).unmet.filter((u) => !policy.relaxable?.includes(u));
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
