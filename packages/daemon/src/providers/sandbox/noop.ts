// The NoopSandbox — the single uniform representation of "cannot enforce". It exists so the
// fail-closed math never branches on null/undefined: a missing/unsupported jail is a real object whose
// capabilities() is [] and whose selfTest() is ok:false. It NEVER confines, so it is never `verified`,
// so the router never relaxes for it and `spawnSandboxed` never trusts it.
import type { Sandbox, SelfTestResult } from '@thaloslab/shared';

export const noopSandbox: Sandbox = {
  id: 'noop',
  detect: async () => ({ available: true }), // "available" as a passthrough, but enforces nothing
  capabilities: () => [],
  selfTest: async (): Promise<SelfTestResult> => ({
    ok: false,
    fsBlocked: false,
    netBlocked: false,
    proof: 'noop sandbox: no confinement',
    id: 'noop',
    os: process.platform,
    verifiedAt: Date.now(),
  }),
  wrap: (cmd, args) => ({ cmd, args }), // identity — runs the command unchanged
};
