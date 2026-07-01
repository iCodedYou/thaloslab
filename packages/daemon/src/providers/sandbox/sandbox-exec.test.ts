// macOS Seatbelt backend (Phase 5b). Three claims, kept DISTINCT:
//  (1) the PURE profile generator + the per-OS errno guard (run EVERYWHERE): the SBPL has the right
//      teeth for a scope, and the darwin-only net-denial codes do NOT loosen the Linux verdict.
//  (2) REAL CONFINEMENT on macOS (DARWIN-GUARDED, mirroring the Linux bwrap guard): the real
//      sandbox-exec jail DENIES the escape probe → selfTest ok:true (fs by host-readback, net by EPERM).
//  (3) VERIFIER TEETH on macOS: a HOLLOW (toothless, allow-default) profile lets the probe ESCAPE → the
//      verdict is STILL ok:false. The verifier must not rubber-stamp sandbox-exec's mere presence.
// This proves sandbox CONFINEMENT on macOS. It does NOT prove the collab round-trip over the wire — the
// peer-agent entrypoint + the cross-machine wire are separate, still-deferred steps.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Sandbox } from '@thaloslab/shared';
import { describe, expect, it } from 'vitest';
import { netBlockedCodes, runEscapeProbe, verdictFromProbe } from './selftest';
import { sandboxExecSandbox, seatbeltProfile } from './sandbox-exec';

const isDarwin = process.platform === 'darwin';

describe('seatbelt profile generation (the jail RULES — not a confinement proof)', () => {
  it('confining scope: deny-write-everywhere + re-allow the (real-path) rw subpath + deny network', () => {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-gen-')));
    try {
      const p = seatbeltProfile({ fsScope: { rw: [dir], hideRest: true }, network: 'none' });
      expect(p).toContain('(allow default)');
      expect(p).toContain('(deny file-write*)');
      expect(p).toContain(`(subpath "${dir}")`); // the rw set, canonicalized, re-allowed
      expect(p).toContain('(deny network*)');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("network:'inherit' omits the network deny (network passes through)", () => {
    const p = seatbeltProfile({ fsScope: { rw: ['/tmp'], hideRest: true }, network: 'inherit' });
    expect(p).not.toContain('(deny network*)');
  });

  it('machine scope (hideRest:false) requests NO fs confinement — the fs is not locked read-only', () => {
    const p = seatbeltProfile({ fsScope: { rw: [], hideRest: false }, network: 'none' });
    expect(p).not.toContain('(deny file-write*)');
    expect(p).toContain('(deny network*)'); // network:none is still enforced
  });
});

describe('per-OS net-denial codes — the darwin fix must NOT loosen the Linux verdict', () => {
  it('linux recognizes ONLY the no-route codes (unchanged — VERIFIED-ON-LINUX preserved)', () => {
    expect(netBlockedCodes('linux')).toEqual([
      'ENETUNREACH',
      'EHOSTUNREACH',
      'ENETDOWN',
      'EADDRNOTAVAIL',
    ]);
  });

  it('darwin ALSO recognizes the Seatbelt syscall-denial codes (EPERM/EACCES)', () => {
    const darwin = netBlockedCodes('darwin');
    expect(darwin).toContain('EPERM');
    expect(darwin).toContain('EACCES');
    // …and it is a strict SUPERSET of linux — Linux semantics are contained, never altered.
    for (const c of netBlockedCodes('linux')) expect(darwin).toContain(c);
  });
});

// A HOLLOW seatbelt jail: it really invokes `sandbox-exec`, but with a TOOTHLESS allow-default profile,
// so it confines NOTHING. Stands for a present-but-misconfigured profile. Used only on darwin (below).
const hollowSeatbelt: Sandbox = {
  id: 'sandbox-exec',
  detect: async () => ({ available: true, version: 'hollow' }),
  capabilities: () => ['fs-scope', 'network-none'], // the lie
  selfTest: async () =>
    verdictFromProbe(await runEscapeProbe(hollowSeatbelt), {
      id: 'sandbox-exec',
      os: 'darwin',
      verifiedAt: 0,
    }),
  wrap: (cmd, args) => ({
    cmd: 'sandbox-exec',
    args: ['-p', '(version 1)(allow default)', cmd, ...args],
  }),
};

// REAL confinement — macOS only, mirroring backends.test.ts' `describe.runIf(bwrapReal)` Linux guard.
// Skips off-darwin so the Linux/Windows gate is unaffected; on macOS CI it is a standing regression guard.
describe.runIf(isDarwin)('REAL sandbox-exec confinement (macOS only) — genuine denial', () => {
  it('detect() reports available + a version on macOS (sandbox-exec is present + callable)', async () => {
    const d = await sandboxExecSandbox.detect();
    expect(d.available).toBe(true);
    expect(typeof d.version).toBe('string');
  });

  it('the REAL jail DENIES the escape probe → selfTest ok:true, fsBlocked, netBlocked', async () => {
    const r = await sandboxExecSandbox.selfTest();
    expect(r.fsBlocked).toBe(true); // the probe's write never reached the host (host-readback)
    expect(r.netBlocked).toBe(true); // network:none → EPERM at the socket under (deny network*)
    expect(r.ok).toBe(true);
    expect(r.id).toBe('sandbox-exec');
  }, 30_000);

  it('VERIFIER TEETH: a HOLLOW (toothless) profile lets the probe ESCAPE → selfTest ok:false', async () => {
    // The trust argument rests on this: the verifier can FAIL on a non-confining jail, not just rubber-
    // stamp a real one — even when sandbox-exec IS invoked (the profile, not the binary, is what confines).
    const r = await hollowSeatbelt.selfTest();
    expect(r.ok).toBe(false);
    expect(r.fsBlocked).toBe(false); // the probe genuinely wrote OUTSIDE the rw set through the toothless jail
  }, 30_000);
});
