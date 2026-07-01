// 5b: the trust-from-self-test invariant for REAL backends. The bar inverts from 5a: 5a proved the
// trust LOGIC against mocks; here we guard the case the user reads hardest — a present-but-
// misconfigured REAL binary. Trust must flow ONLY from a passed self-test, NEVER from "the binary is
// there". On this Windows box there is no Linux/WSL/Docker, so NO real jail is verifiable here:
// detectSandbox() falls back to NoopSandbox. The real bubblewrap confinement is now VERIFIED-ON-LINUX
// (2026-06-30) — re-proven by the guarded `describe.runIf(linux + bwrap)` block below, which runs the
// real self-test on any Linux box and skips here.
import type { Sandbox, ToolPolicy } from '@thaloslab/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { whichSync } from '../which';
import { bubblewrapSandbox } from './bubblewrap';
import { noopSandbox } from './noop';
import {
  detectSandbox,
  resetSandbox,
  resolveSandboxBinding,
  setSandbox,
  trustedCapabilities,
} from './index';

const policy: ToolPolicy = {
  canRead: true,
  canWrite: true,
  canExecCommands: true,
  commandAllowlist: ['git *'],
  network: 'none',
  pathScope: 'own-worktree',
};

// A REAL backend that is DETECTED (binary present) but whose jail does NOT actually confine — its
// self-test FAILS. This stands for bubblewrap/nsjail/docker installed but misconfigured.
const hollowRealBackend: Sandbox = {
  id: 'bubblewrap',
  detect: async () => ({ available: true, version: '0.bad' }),
  capabilities: () => ['fs-scope', 'network-none'],
  selfTest: async () => ({
    ok: false, // the escape probe was NOT denied
    fsBlocked: false,
    netBlocked: true,
    proof: 'probe escaped fs',
    id: 'bubblewrap',
    os: 'linux',
    verifiedAt: 0,
  }),
  wrap: (cmd, args) => ({ cmd, args }), // does not actually confine
};

const confiningBackend: Sandbox = {
  ...hollowRealBackend,
  selfTest: async () => ({
    ok: true,
    fsBlocked: true,
    netBlocked: true,
    proof: 'denied',
    id: 'bubblewrap',
    os: 'linux',
    verifiedAt: 0,
  }),
};

afterEach(() => resetSandbox());

describe('trust flows ONLY from a passed self-test, never from "the binary is present"', () => {
  it('a DETECTED-but-self-test-FAILING real backend is treated exactly like Noop (not trusted)', async () => {
    setSandbox(hollowRealBackend);
    const binding = await resolveSandboxBinding(policy, '/tmp/wt', { required: false });
    expect(binding.verified).toBe(false); // present, but its jail did not confine
    expect(trustedCapabilities(binding)).toEqual([]); // ⇒ the router relaxes NOTHING for it
  });

  it('only a backend whose self-test PASSED is trusted with its capabilities', async () => {
    setSandbox(confiningBackend);
    const binding = await resolveSandboxBinding(policy, '/tmp/wt', { required: false });
    expect(binding.verified).toBe(true);
    expect(trustedCapabilities(binding)).toEqual(['fs-scope', 'network-none']);
  });
});

describe('this build machine — honest per-OS state', () => {
  it('detectSandbox picks the real per-OS candidate when present, else NoopSandbox', async () => {
    // No override: detectSandbox uses the platform candidates. Linux → bubblewrap (if bwrap present);
    // macOS → sandbox-exec (always present); Windows-without-WSL/Docker → the empty set → NoopSandbox.
    const handle = await detectSandbox();
    if (process.platform === 'linux') {
      expect(['bubblewrap', 'noop']).toContain(handle.id);
    } else if (process.platform === 'darwin') {
      expect(['sandbox-exec', 'noop']).toContain(handle.id);
    } else {
      expect(handle).toBe(noopSandbox);
    }
  });
});

// VERIFIED-ON-LINUX: the permanent, re-runnable form of the DEFERRED-PENDING-LINUX verification. On a
// real Linux kernel with bwrap present, the REAL self-test must PASS — a genuine escape DENIAL, not a
// reported one (fs by host-readback, net by a no-route error under --unshare-net). First run green on
// kernel 6.18.x WSL2 + bubblewrap 0.11.1 (see DECISIONS "Deferred / open items"). Skips off-Linux /
// without bwrap, so the Windows gate is unaffected; on Linux CI it is a standing regression guard.
const bwrapReal = process.platform === 'linux' && Boolean(whichSync('bwrap'));

describe.runIf(bwrapReal)(
  'REAL bubblewrap confinement (Linux + bwrap only) — genuine denial',
  () => {
    it('the real jail DENIES the escape probe → selfTest ok:true, fsBlocked, netBlocked', async () => {
      const r = await bubblewrapSandbox.selfTest();
      expect(r.fsBlocked).toBe(true); // the probe's write never reached the host (host-readback)
      expect(r.netBlocked).toBe(true); // network:none → no route to a routable address
      expect(r.ok).toBe(true);
    }, 30_000);
  },
);

describe('bubblewrap command construction (the jail FLAGS — not a confinement proof)', () => {
  it('builds a read-only host bind + writable rw set + unshared net for network:none', () => {
    const { cmd, args } = bubblewrapSandbox.wrap('node', ['x.mjs'], {
      fsScope: { rw: ['/work/wt'], hideRest: true },
      network: 'none',
    });
    expect(cmd).toBe('bwrap');
    expect(args).toContain('--ro-bind');
    expect(args.join(' ')).toContain('--bind /work/wt /work/wt');
    expect(args).toContain('--unshare-net'); // network:none → no net namespace
    expect(args.slice(args.indexOf('--') + 1)).toEqual(['node', 'x.mjs']);
  });

  it('inherits the network (no --unshare-net) when the policy allows it', () => {
    const { args } = bubblewrapSandbox.wrap('node', [], {
      fsScope: { rw: ['/w'], hideRest: true },
      network: 'inherit',
    });
    expect(args).not.toContain('--unshare-net');
  });
});
