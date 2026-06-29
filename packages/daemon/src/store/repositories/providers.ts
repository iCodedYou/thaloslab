// Data access for the `providers` table (Phase 0, DECISIONS #19). Upserted by provider detection.
import type { DetectedProvider, ProviderKind } from '@thaloslab/shared';
import { getDb } from '../db';
import { providers } from '../schema';

type Row = typeof providers.$inferSelect;

function toDetected(row: Row): DetectedProvider {
  return {
    id: row.id,
    kind: row.kind as ProviderKind,
    displayName: row.displayName,
    installed: row.installed === 1,
    authenticated: row.authenticated === 1,
    version: row.version ?? undefined,
    lastChecked: row.lastChecked ?? 0,
  };
}

export function listProviders(): DetectedProvider[] {
  return getDb().select().from(providers).all().map(toDetected);
}

export function upsertProvider(p: DetectedProvider): void {
  const values = {
    id: p.id,
    kind: p.kind,
    displayName: p.displayName,
    installed: p.installed ? 1 : 0,
    authenticated: p.authenticated ? 1 : 0,
    version: p.version ?? null,
    lastChecked: p.lastChecked,
  };
  getDb()
    .insert(providers)
    .values({ ...values, peerId: null })
    .onConflictDoUpdate({
      target: providers.id,
      set: {
        kind: values.kind,
        displayName: values.displayName,
        installed: values.installed,
        authenticated: values.authenticated,
        version: values.version,
        lastChecked: values.lastChecked,
      },
    })
    .run();
}
