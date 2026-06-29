// Adapter registry + detection sweep. detectAll() probes every adapter (zero token spend) and
// upserts results into the providers table. Phase 0 registers Claude only.
import type { DetectedProvider, ProviderAdapter } from '@thaloslab/shared';
import { upsertProvider } from '../store/repositories/providers';
import { claudeAdapter } from './claude';

const adapters: ProviderAdapter[] = [claudeAdapter];

export function getAdapters(): ProviderAdapter[] {
  return adapters;
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
