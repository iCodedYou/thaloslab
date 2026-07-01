// macOS Seatbelt (sandbox-exec) — the native macOS REAL jail. `sandbox-exec` is deprecated but ships
// on and is callable from every macOS; this backend compiles an SBPL profile that makes `pathScope` and
// `network:none` OS-REAL: `file-write*` is denied everywhere EXCEPT the rw set (+ the /dev nodes a
// process must write) and `network:none` denies the socket outright. Reads stay allowed, so the rest of
// the fs is effectively read-only — the SAME posture bubblewrap's `--ro-bind / /` gives — and node / git
// / the CLIs still run. The other defense-in-depth layers (path-audit, denylist, provider flags) remain
// the floor for everything this profile does not constrain.
//
// ✅ CONFINEMENT VERIFIED-ON-MACOS (2026-06-30, macOS 26.3 / arm64, Apple M4 Pro): the self-test's escape
// probe was genuinely DENIED on both axes — fs by HOST-READBACK (the probe's write to a HOST path OUTSIDE
// the rw set returned EPERM and never reached the host file) and net by EPERM at the socket under
// `(deny network*)` — ⇒ `selfTest().ok=true`. Trust STILL flows ONLY from `selfTest().ok`: a present-but-
// toothless profile (the hollow case) lets the probe escape and is treated EXACTLY like NoopSandbox (not
// trusted → no relaxation, fail-closed for collab). Exact invocation: `sandbox-exec -p '<profile>' cmd args`.
import fs from 'node:fs';
import os from 'node:os';
import type { Sandbox, SandboxScope, SelfTestResult } from '@thaloslab/shared';
import { execa } from 'execa';
import { whichSync } from '../which';
import { runEscapeProbe, verdictFromProbe } from './selftest';

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

// The /dev nodes a normal process expects to be able to write — re-allowed even when writes are otherwise
// denied (mirrors the writable /dev a container/namespace jail provides).
const DEV_WRITABLE = [
  '/dev/null',
  '/dev/zero',
  '/dev/random',
  '/dev/urandom',
  '/dev/dtracehelper',
  '/dev/tty',
  '/dev/fd',
];

/** Canonicalize a path for SBPL: Seatbelt matches against the REAL (symlink-resolved) path, and on macOS
 *  the tmp/worktree dirs sit behind `/var → /private/var` and `/tmp → /private/tmp`. Fall back to the
 *  literal path if it can't be resolved (best effort; a non-existent path can't be a rw target anyway). */
function realpath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

/** Escape a path for an SBPL double-quoted string literal (defensive — worktree paths rarely contain
 *  these, but a stray `"`/`\` would otherwise break the profile). */
function sbplString(p: string): string {
  return `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Compile a `SandboxScope` into a Seatbelt profile. `(allow default)` with exactly two teeth:
 *  - **fs:** when the scope asks to confine the fs (`hideRest`), `(deny file-write*)` then re-allow the
 *    rw subpaths (last rule wins) + the /dev nodes. A write OUTSIDE the rw set hits only the deny → EPERM.
 *  - **net:** `(deny network*)` for `network:'none'`; omitted for `'inherit'` (network passes through).
 * `machine` scope (`hideRest:false`, no rw) requests NO fs confinement, so the write-deny is omitted
 * rather than locking the whole fs read-only. Pure — no temp file, no side effects.
 */
export function seatbeltProfile(scope: SandboxScope): string {
  const lines = ['(version 1)', '(allow default)'];
  if (scope.fsScope.hideRest) {
    lines.push('(deny file-write*)');
    const rw = scope.fsScope.rw.map(realpath).filter(Boolean);
    if (rw.length) {
      lines.push(`(allow file-write* ${rw.map((d) => `(subpath ${sbplString(d)})`).join(' ')})`);
    }
    lines.push(
      `(allow file-write* ${DEV_WRITABLE.map((d) => `(literal ${sbplString(d)})`).join(' ')})`,
    );
  }
  if (scope.network === 'none') lines.push('(deny network*)');
  return lines.join('\n');
}

export const sandboxExecSandbox: Sandbox = {
  id: 'sandbox-exec',
  detect: async () => {
    if (process.platform !== 'darwin') return { available: false };
    const bin = whichSync('sandbox-exec') ?? (fs.existsSync(SANDBOX_EXEC) ? SANDBOX_EXEC : null);
    if (!bin) return { available: false };
    // "Callable" — actually RUN it (sandbox-exec has no `--version`): a trivial allow-all profile around
    // `/usr/bin/true` must exit 0. Availability ≠ trust; the self-test is the real gate. Version = the
    // Darwin kernel release (Seatbelt has no own version, and an OS update is what could change its
    // behavior — so it is the right cache-invalidation key alongside `(id, os, arch)`).
    try {
      await execa(bin, ['-p', '(version 1)(allow default)', '/usr/bin/true'], { timeout: 5_000 });
      return { available: true, version: os.release() };
    } catch {
      return { available: false };
    }
  },
  capabilities: () => ['fs-scope', 'network-none'],
  selfTest: async (): Promise<SelfTestResult> =>
    verdictFromProbe(await runEscapeProbe(sandboxExecSandbox), {
      id: 'sandbox-exec',
      version: os.release(),
      os: process.platform,
      verifiedAt: Date.now(),
    }),
  wrap: (cmd, args, scope) => ({
    cmd: 'sandbox-exec',
    args: ['-p', seatbeltProfile(scope), cmd, ...args],
  }),
};
