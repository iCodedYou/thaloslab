// 5a proves the TRUST-DECISION LOGIC (refuse on absent/failed verification; relax only on a passed
// self-test), against mock sandboxes whose self-test results we control. It does NOT prove that real
// bubblewrap/sandbox-exec confine — that is 5b (DEFERRED-PENDING-LINUX/MACOS), where the same
// self-test runs against the real jail before that OS is trusted. The mock validates the trust logic;
// only the on-target self-test validates real confinement.
import type { Sandbox, SandboxBinding } from '@thaloslab/shared';
import { describe, expect, it } from 'vitest';
import { noopSandbox } from './noop';
import { parseProbe, runEscapeProbe, verdictFromProbe } from './selftest';
import { SandboxRequiredError, spawnSandboxed } from './spawn';

// A HOLLOW sandbox: it LIES — advertises fs-scope + network-none and a wrap that "succeeds", but the
// wrap is identity, so it does not actually confine. Its self-test runs the REAL escape probe, which
// (on any OS, unconfined) writes outside rw + reaches the stack → the verifier MUST return ok:false.
const hollowSandbox: Sandbox = {
  id: 'noop',
  detect: async () => ({ available: true, version: '1.0' }),
  capabilities: () => ['fs-scope', 'network-none'], // the lie
  selfTest: async () =>
    verdictFromProbe(await runEscapeProbe(hollowSandbox), {
      id: 'hollow',
      os: process.platform,
      verifiedAt: 0,
    }),
  wrap: (cmd, args) => ({ cmd, args }), // identity — confines NOTHING
};

describe('the self-test is the keystone (verified ⇔ an escape was PROVEN blocked)', () => {
  it('VERIFIER TEETH: a hollow jail whose probe ESCAPES yields selfTest.ok:false (real, this OS)', async () => {
    // The deferral-safety argument rests entirely on this: the self-test can FAIL on a non-confining
    // jail, not just rubber-stamp a real one. An always-ok self-test would pass every Windows test and
    // defer to Linux looking green — a believed-but-hollow verifier. Here the probe really escapes.
    const r = await hollowSandbox.selfTest();
    expect(r.ok).toBe(false);
    expect(r.fsBlocked).toBe(false); // the probe genuinely wrote OUTSIDE the rw set
  });

  it('the verdict logic discriminates BOTH directions (pure)', () => {
    const meta = { id: 'x', os: 'linux', verifiedAt: 0 };
    expect(verdictFromProbe({ wroteOutside: false, connectedOut: false, raw: '' }, meta).ok).toBe(
      true,
    ); // both escapes blocked → confined
    expect(verdictFromProbe({ wroteOutside: true, connectedOut: false, raw: '' }, meta).ok).toBe(
      false,
    ); // fs escaped → not confined
    expect(verdictFromProbe({ wroteOutside: false, connectedOut: true, raw: '' }, meta).ok).toBe(
      false,
    ); // net escaped → not confined
  });

  it('an unparseable/absent probe transcript is treated as reachable on both axes (fail-closed)', () => {
    // If we cannot read the probe, we don't get to call it confined.
    expect(parseProbe('garbage, no marker')).toEqual({ selfWrote: true, connectedOut: true });
  });

  it('NoopSandbox is the uniform "cannot enforce": caps=[] and selfTest never ok', async () => {
    expect(noopSandbox.capabilities()).toEqual([]);
    expect((await noopSandbox.selfTest()).ok).toBe(false);
  });
});

const handle: Sandbox = {
  id: 'noop',
  detect: async () => ({ available: true }),
  capabilities: () => [],
  selfTest: async () => ({
    ok: false,
    fsBlocked: false,
    netBlocked: false,
    proof: '',
    id: 'noop',
    os: 'test',
    verifiedAt: 0,
  }),
  wrap: (cmd, args) => ({ cmd, args }),
};
const binding = (over: Partial<SandboxBinding>): SandboxBinding => ({
  handle,
  scope: { fsScope: { rw: [], hideRest: true }, network: 'none' },
  verified: false,
  requiredByRouter: false,
  ...over,
});

describe('spawnSandboxed is the fail-closed chokepoint', () => {
  it('REFUSES (throws) when a sandbox is REQUIRED but not verified — the unsafe path cannot run', () => {
    expect(() =>
      spawnSandboxed('node', ['-e', ''], { reject: false }, binding({ requiredByRouter: true })),
    ).toThrow(SandboxRequiredError);
  });

  it('runs UNWRAPPED when not required (local defense-in-depth, behavior unchanged)', async () => {
    const res = await spawnSandboxed(
      'node',
      ['-e', 'process.stdout.write("ran")'],
      { reject: false },
      binding({ verified: false, requiredByRouter: false }),
    );
    expect(res.stdout).toContain('ran');
  });

  it('WRAPS the command when verified (the jail actually gets to confine it)', async () => {
    let wrapped = false;
    const wrapHandle: Sandbox = {
      ...handle,
      wrap: (cmd, args) => {
        wrapped = true;
        return { cmd, args };
      },
    };
    await spawnSandboxed(
      'node',
      ['-e', '""'],
      { reject: false },
      binding({ handle: wrapHandle, verified: true, requiredByRouter: true }),
    );
    expect(wrapped).toBe(true);
  });
});
