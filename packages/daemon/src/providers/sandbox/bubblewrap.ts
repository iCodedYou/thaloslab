// Bubblewrap (Linux) — the reference REAL jail. Rootless user namespaces: the host fs is exposed
// read-only, only the rw set is writable, /tmp is a fresh tmpfs, and network:none unshares the net
// namespace. A probe that writes outside the rw set lands on the ro host fs (EROFS) or the throwaway
// tmpfs — never the host file (proven by the self-test's host-readback).
//
// ⚠️ CONFINEMENT-UNVERIFIED ON THE BUILD MACHINE (DEFERRED-PENDING-LINUX): this Windows box has no
// Linux/WSL, so the self-test below could not be run against a REAL bwrap jail here. Trust flows ONLY
// from `selfTest().ok` — which runs the real escape probe on-target and is true only if the probe was
// genuinely DENIED. A bwrap that is present but misconfigured fails its self-test and is treated
// exactly like NoopSandbox (present-but-not-trusted → no relaxation, fail-closed for collab).
import type { Sandbox, SandboxScope, SelfTestResult } from '@thaloslab/shared';
import { execa } from 'execa';
import { whichSync } from '../which';
import { runEscapeProbe, verdictFromProbe } from './selftest';

function bwrapArgs(cmd: string, args: string[], scope: SandboxScope): string[] {
  const a = [
    '--die-with-parent',
    '--new-session',
    '--unshare-user',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--ro-bind',
    '/',
    '/', // host fs read-only…
    '--tmpfs',
    '/tmp', // …with a throwaway writable /tmp (so a stray write never reaches the host)
    '--proc',
    '/proc',
    '--dev',
    '/dev',
  ];
  for (const d of scope.fsScope.rw) a.push('--bind', d, d); // re-expose the rw set writable (wins, last)
  if (scope.network === 'none') a.push('--unshare-net');
  a.push('--', cmd, ...args);
  return a;
}

export const bubblewrapSandbox: Sandbox = {
  id: 'bubblewrap',
  detect: async () => {
    if (process.platform !== 'linux') return { available: false };
    const bin = whichSync('bwrap');
    if (!bin) return { available: false };
    try {
      const v = await execa('bwrap', ['--version'], { timeout: 5_000 });
      return { available: true, version: v.stdout.trim() };
    } catch {
      return { available: false };
    }
  },
  capabilities: () => ['fs-scope', 'network-none', 'no-new-privs', 'pid-limit'],
  selfTest: async (): Promise<SelfTestResult> =>
    verdictFromProbe(await runEscapeProbe(bubblewrapSandbox), {
      id: 'bubblewrap',
      os: process.platform,
      verifiedAt: Date.now(),
    }),
  wrap: (cmd, args, scope) => ({ cmd: 'bwrap', args: bwrapArgs(cmd, args, scope) }),
};
