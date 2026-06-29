// Persistence for the context manifests (the INFORM half of axis 3). The manifest viewer is a SECURITY
// surface, not a nicety: it must show the REAL record of exactly what crossed the trust boundary — the
// path + sha256 of every file sent, and the secret-bearing files that were withheld. Persisted as a
// host artifact when a pack is built for a peer; read back verbatim by the collab UI.
import fs from 'node:fs';
import path from 'node:path';
import { THALOS_DIR_NAME } from '@thaloslab/shared';
import type { ContextPack } from './context-pack';

export interface PersistedManifest {
  runId: string;
  peerId: string;
  createdAt: number;
  entries: ContextPack['manifest']; // path + sha256 + bytes of exactly what crossed
  excluded: string[]; // secret-bearing files withheld (visible to the host)
}

function manifestsDir(repoPath: string): string {
  return path.join(repoPath, THALOS_DIR_NAME, 'collab-manifests');
}

/** Record exactly what crossed for a given peer invocation. Called when the pack is sent. */
export function persistManifest(
  repoPath: string,
  m: { runId: string; peerId: string; createdAt: number; pack: ContextPack },
): void {
  const dir = manifestsDir(repoPath);
  fs.mkdirSync(dir, { recursive: true });
  const record: PersistedManifest = {
    runId: m.runId,
    peerId: m.peerId,
    createdAt: m.createdAt,
    entries: m.pack.manifest,
    excluded: m.pack.excluded,
  };
  fs.writeFileSync(path.join(dir, `${m.runId}.json`), JSON.stringify(record, null, 2), 'utf8');
}

export function readManifest(repoPath: string, runId: string): PersistedManifest | null {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(manifestsDir(repoPath), `${runId}.json`), 'utf8'),
    ) as PersistedManifest;
  } catch {
    return null;
  }
}

/** Every persisted manifest for the project, newest first — what the collab UI lists. */
export function listManifests(repoPath: string): PersistedManifest[] {
  let names: string[];
  try {
    names = fs.readdirSync(manifestsDir(repoPath)).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  return names
    .map((n) => readManifest(repoPath, n.replace(/\.json$/, '')))
    .filter((m): m is PersistedManifest => m !== null)
    .sort((a, b) => b.createdAt - a.createdAt);
}
