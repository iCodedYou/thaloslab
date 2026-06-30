// Adapter registry + detection sweep. detectAll() probes every adapter (zero token spend) and
// upserts results into the providers table. Phase 1 adds mode-aware routing: --mock returns the
// scripted mock adapter (zero tokens) for every role; --live/--preview return the real adapter.
import type { DetectedProvider, ProviderId, SandboxCapability } from '@thaloslab/shared';
import { getProject } from '../store/repositories/projects';
import { listProviders, upsertProvider } from '../store/repositories/providers';
// The DB-FREE adapter access lives in ./adapters (so the collab peer can reuse it without the store);
// re-exported here so existing importers (stage-runner, registry.test) are unchanged.
import { getAdapter, getAdapters } from './adapters';
import { type RouterCtx, sandboxSatisfies } from './router';

export { getAdapters, getAdapter, adapterFor } from './adapters';

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
    preferenceOrder: configured ?? getAdapters().map((a) => a.id),
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
  for (const adapter of getAdapters()) {
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
