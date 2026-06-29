// Doom-loop detection (SPEC §7, mandatory). Escalates on ANY of: per-gate-loop retry cap,
// whole-loop attempt cap (independent — bounds the fix↔review round-trip), a repeated error
// signature, or no forward progress. Pure functions over task counters + recent runs → survive
// restart and are trivially testable. The hard caps are the absolute backstop against runaway spend.
import { createHash } from 'node:crypto';
import type { Run } from '@thaloslab/shared';

export interface DoomConfig {
  /** Per-gate-loop iterations (StageDef.loop.retryCap). */
  retryCap: number;
  /** Whole-loop entries incl. review bounce-backs — independent backstop. */
  attemptCap: number;
}

export type DoomReason = 'attempt-cap' | 'retry-cap' | 'repeat-signature' | 'no-progress';

export interface DoomVerdict {
  stuck: boolean;
  reason?: DoomReason;
}

/**
 * Normalize a failure into a comparable signature: strip absolute paths, line:col, timestamps,
 * hex addresses, durations, and bare numbers so the SAME logical error across different runs
 * hashes equal (the whole game — weak normalization causes false negatives), while genuinely
 * different errors stay distinct.
 */
export function normalizeError(raw: string): string {
  let s = raw.toLowerCase();
  s = s.replace(/[a-z]:\\[^\s:*?"<>|]+/g, '<path>'); // windows abs paths
  s = s.replace(/(?:\.{0,2}\/)[^\s:*?"<>|]+/g, '<path>'); // posix/relative paths
  s = s.replace(/\d{4}-\d{2}-\d{2}t[\d:.]+z?/g, '<ts>'); // iso timestamps
  s = s.replace(/0x[0-9a-f]+/g, '<hex>'); // hex addresses
  s = s.replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|sec|secs)\b/g, '<dur>'); // durations
  s = s.replace(/:\d+:\d+/g, ':<lc>'); // line:col
  s = s.replace(/:\d+\b/g, ':<n>'); // :line
  s = s.replace(/\b\d+\b/g, '<num>'); // remaining bare numbers
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/** Stable short hash of the normalized failure — stored on `runs.error_signature`. */
export function errorSignature(rawOutput: string): string {
  return createHash('sha1').update(normalizeError(rawOutput)).digest('hex').slice(0, 16);
}

function isFailed(run: Run): boolean {
  return run.status === 'error' || run.status === 'timeout';
}

function changedKey(run: Run): string {
  return JSON.stringify([...(run.changedFiles ?? [])].sort());
}

/**
 * @param task counters — `attempt` = whole-loop entries, `retryCount` = per-gate-loop iterations.
 * @param recentRuns newest-first (e.g. from recentRunsForTask).
 */
export function detectDoomLoop(
  task: { attempt: number; retryCount: number },
  recentRuns: Run[],
  cfg: DoomConfig,
): DoomVerdict {
  // Hard caps first — absolute backstops, independent of any signature heuristic.
  if (task.attempt >= cfg.attemptCap) return { stuck: true, reason: 'attempt-cap' };
  if (task.retryCount >= cfg.retryCap) return { stuck: true, reason: 'retry-cap' };

  const failed = recentRuns.filter(isFailed);
  if (failed.length >= 2) {
    const [a, b] = failed;
    if (a && b) {
      if (a.errorSignature && a.errorSignature === b.errorSignature) {
        return { stuck: true, reason: 'repeat-signature' };
      }
      if (changedKey(a) === changedKey(b)) {
        return { stuck: true, reason: 'no-progress' };
      }
    }
  }
  return { stuck: false };
}
