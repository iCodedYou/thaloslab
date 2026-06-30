// New coverage (Phase 6): the lockfile parse the reuse-or-spawn lifecycle depends on. A malformed or
// partial lockfile must read as "no daemon" (null), never as a half-valid record — that's what makes
// "reuse a healthy daemon, else clean + spawn" safe.
import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs');
const { readLockfile } = await import('./app-paths');

describe('readLockfile — parse + validation', () => {
  afterEach(() => vi.clearAllMocks());

  it('parses a well-formed lockfile', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ pid: 42, port: 8473, startedAt: 9 }),
    );
    expect(readLockfile()).toEqual({ pid: 42, port: 8473, startedAt: 9 });
  });

  it('returns null on malformed JSON', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('{ not json');
    expect(readLockfile()).toBeNull();
  });

  it('returns null when a required field is missing or wrong-typed', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ pid: '42', port: 8473 }));
    expect(readLockfile()).toBeNull();
  });

  it('returns null when the file is absent (read throws)', () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    expect(readLockfile()).toBeNull();
  });
});
