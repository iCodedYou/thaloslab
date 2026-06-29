import type { Run } from '@thaloslab/shared';
import { describe, expect, it } from 'vitest';
import { detectDoomLoop, errorSignature, normalizeError } from './stuck';

function failedRun(id: string, opts: { sig?: string; changed?: string[] } = {}): Run {
  return {
    id,
    taskId: 'task1',
    provider: 'mock',
    status: 'error',
    startedAt: 0,
    errorSignature: opts.sig,
    changedFiles: opts.changed,
  };
}

const CFG = { retryCap: 3, attemptCap: 6 };

describe('error signature normalization', () => {
  it('hashes the SAME logical error equal across different paths and line numbers', () => {
    const a = 'Error at C:\\Users\\alice\\proj\\src\\fix.ts:12:5: expected 3 received 4';
    const b = 'Error at C:\\Users\\bob\\other\\lib\\fix.ts:88:1: expected 3 received 4';
    expect(normalizeError(a)).toBe(normalizeError(b));
    expect(errorSignature(a)).toBe(errorSignature(b));
  });

  it('strips timestamps, hex addresses, and durations', () => {
    const a = 'failed 2026-06-28T10:00:00Z at 0xABCDEF in 123ms';
    const b = 'failed 2026-01-01T23:59:59Z at 0x001122 in 7.5s';
    expect(normalizeError(a)).toBe(normalizeError(b));
  });

  it('keeps genuinely different errors distinct (false-negative guard)', () => {
    const typeErr = "TypeError: cannot read property 'x' of undefined";
    const assertErr = 'AssertionError: expected true to be false';
    expect(normalizeError(typeErr)).not.toBe(normalizeError(assertErr));
    expect(errorSignature(typeErr)).not.toBe(errorSignature(assertErr));
  });
});

describe('detectDoomLoop: hard caps are independent', () => {
  it('attempt-cap fires even when every signature is distinct and retryCount is low', () => {
    const runs = [
      failedRun('r2', { sig: 'zzz', changed: ['b.ts'] }),
      failedRun('r1', { sig: 'aaa', changed: ['a.ts'] }),
    ];
    const v = detectDoomLoop({ attempt: 6, retryCount: 0 }, runs, CFG);
    expect(v).toEqual({ stuck: true, reason: 'attempt-cap' });
  });

  it('retry-cap fires even when attempt is low', () => {
    const v = detectDoomLoop({ attempt: 0, retryCount: 3 }, [], CFG);
    expect(v).toEqual({ stuck: true, reason: 'retry-cap' });
  });
});

describe('detectDoomLoop: heuristics under the caps', () => {
  it('repeat-signature: two consecutive failures share a signature', () => {
    const runs = [
      failedRun('r2', { sig: 'same', changed: ['b.ts'] }),
      failedRun('r1', { sig: 'same', changed: ['a.ts'] }),
    ];
    expect(detectDoomLoop({ attempt: 2, retryCount: 1 }, runs, CFG)).toEqual({
      stuck: true,
      reason: 'repeat-signature',
    });
  });

  it('no-progress: identical changed files across two failures with distinct signatures', () => {
    const runs = [
      failedRun('r2', { sig: 'x2', changed: ['a.ts', 'b.ts'] }),
      failedRun('r1', { sig: 'x1', changed: ['b.ts', 'a.ts'] }), // same set, different order
    ];
    expect(detectDoomLoop({ attempt: 2, retryCount: 1 }, runs, CFG)).toEqual({
      stuck: true,
      reason: 'no-progress',
    });
  });

  it('not stuck: distinct signatures AND distinct changed files under the caps', () => {
    const runs = [
      failedRun('r2', { sig: 'x2', changed: ['c.ts'] }),
      failedRun('r1', { sig: 'x1', changed: ['a.ts'] }),
    ];
    expect(detectDoomLoop({ attempt: 1, retryCount: 0 }, runs, CFG)).toEqual({ stuck: false });
  });

  it('not stuck: only one failure so far', () => {
    expect(
      detectDoomLoop({ attempt: 1, retryCount: 0 }, [failedRun('r1', { sig: 'x1' })], CFG),
    ).toEqual({ stuck: false });
  });
});
