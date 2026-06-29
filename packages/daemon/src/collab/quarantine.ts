// Axis 2 of the collab threat model (OUTPUT INTEGRITY) — a peer's result is UNTRUSTED DATA, never an
// effect. The host applies the peer's patch into the isolated lane worktree (the quarantine), then
// derives the changed set from its OWN git and runs the seam/path audit — never from the peer's
// self-report. Combined with the StageRunner re-running ALL gates on the result, a malicious peer's
// poisoned patch, out-of-seam write, or lie ("ok:true, nothing changed") cannot land unchecked.
import fs from 'node:fs';
import path from 'node:path';
import { changedFiles } from '../util/git';
import { outOfSeam } from '../workflow/decomposition';
import type { PeerResult } from './protocol';

export interface QuarantineVerdict {
  /** The changed set per the HOST's git — authoritative. The peer's `changedFiles` is ignored. */
  changedFiles: string[];
  /** Files written OUTSIDE the lane's declared seam (a scope breach). Empty ⇒ in-seam. */
  seamViolation: string[];
}

/**
 * Apply a peer's patch into the quarantine worktree and audit it with HOST-derived facts. Returns the
 * host's own changed-file set + any seam violation. The caller (StageRunner) then re-runs the gates
 * on this worktree — the peer's `ok` is never consumed as truth.
 */
export async function applyPeerPatch(
  cwd: string,
  result: PeerResult,
  seamPaths?: string[],
): Promise<QuarantineVerdict> {
  for (const [rel, content] of Object.entries(result.patch)) {
    const safe = path.normalize(rel).replace(/\\/g, '/');
    if (safe.startsWith('../') || path.isAbsolute(safe)) continue; // never write outside the worktree
    const abs = path.join(cwd, safe);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  const changed = await changedFiles(cwd); // HOST git — NOT result.changedFiles
  const seamViolation = seamPaths?.length ? outOfSeam(changed, seamPaths) : [];
  return { changedFiles: changed, seamViolation };
}
