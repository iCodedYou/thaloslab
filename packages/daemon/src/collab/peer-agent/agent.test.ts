// Wire C acceptance: the first REAL peer on the wire. The headline is the GENUINE Axis-1 refusal — on
// this Windows box the peer's REAL sandbox is NoopSandbox, so it self-tests HONESTLY as unverified
// (nothing forces it — that's the truth of the hardware), advertises that, and is REFUSED at join over
// the real socket. Plus the peer's OWN invoke-refusal gate (defense in depth): even if an invoke
// arrives, the peer re-derives its binding and refuses BEFORE the adapter (an explicit binding.verified
// check, because --mock bypasses spawnSandboxed).
//
// Two claims kept distinct: this proves the WIRE + the trust decision over a real socket. It does NOT
// prove a real jail confined anything — on Windows there IS no real jail (that's why the honest peer is
// refused); real confinement was proven separately (VERIFIED-ON-LINUX).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Sandbox, ToolPolicy } from '@thaloslab/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetSandbox, setSandbox } from '../../providers/sandbox';
import { noopSandbox } from '../../providers/sandbox/noop';
import { CollabService } from '../collab-service';
import { CollabRuntime } from '../runtime';
import { buildPeerHello, connectPeer, peerSelfTest, runPeerInvoke } from './agent';

// A test-seam "verified" backend (stands in for a real jail proven elsewhere — VERIFIED-ON-LINUX). Used
// ONLY to show the gate OPENS; it does NOT confine anything here.
const confiningSeam: Sandbox = {
  id: 'bubblewrap',
  detect: async () => ({ available: true, version: 'seam' }),
  capabilities: () => ['fs-scope', 'network-none'],
  selfTest: async () => ({
    ok: true,
    fsBlocked: true,
    netBlocked: true,
    proof: 'seam (NOT a real jail)',
    id: 'bubblewrap',
    os: 'linux',
    verifiedAt: 0,
  }),
  wrap: (cmd, args) => ({ cmd, args }),
};

const policy: ToolPolicy = {
  canRead: true,
  canWrite: true,
  canExecCommands: true,
  network: 'none',
  pathScope: 'own-worktree',
};
const req = { policy, providerId: 'codex', prompt: 'x', contextManifest: [], files: [] };

afterEach(() => resetSandbox());

describe('Wire C — honest self-test + genuine Axis-1 refusal over the real socket', () => {
  it('the peer self-test is HONEST — it reports the REAL sandbox of this machine (nothing forces it)', async () => {
    resetSandbox(); // the real platform sandbox, not an override
    const honest = await peerSelfTest();
    expect(typeof honest.ok).toBe('boolean');
    if (process.platform === 'win32') {
      // genuine NoopSandbox here ⇒ unverified, because Windows has no real jail. Not a forced value.
      expect(honest.ok).toBe(false);
      expect(honest.id).toBe('noop');
    }
  });

  it('GENUINE Axis 1: the honest (unverified-here) peer is REFUSED at join over the real socket', async () => {
    resetSandbox();
    const svc = new CollabService(new CollabRuntime());
    const port = await svc.enable({ port: 0 });
    try {
      const honest = await peerSelfTest();
      const token = svc.invite('peerB');
      const hello = await buildPeerHello('peerB', [
        { id: 'codex', vendor: 'codex', authenticated: true },
      ]);
      expect(hello.sandbox).toEqual(honest); // the hello carries the HONEST self-test, verbatim

      const peer = await connectPeer({
        url: `ws://127.0.0.1:${port}`,
        peerId: 'peerB',
        token,
        hello,
        cwd: os.tmpdir(),
      });
      const first = await peer.next();

      if (!honest.ok) {
        // The genuine refusal on real hardware (Windows): no verified jail ⇒ host refuses at JOIN.
        expect(first.t).toBe('join.rejected');
        expect(String((first as { reason?: unknown }).reason)).toContain('sandbox');
        expect(svc.host.authorized('peerB')).toBe(false);
      } else {
        // A verified box (Linux + bubblewrap) would PARK on pending, admittable — the verified happy
        // path is Wire D (via a test seam). Either way the host's decision MATCHES the honest self-test.
        expect(first.t).toBe('join.pending');
      }
      peer.close();
    } finally {
      await svc.disable();
    }
  });

  it('the peer REFUSES on its OWN side at invoke — explicit binding.verified gate, adapter NOT called', async () => {
    setSandbox(noopSandbox); // force unverified deterministically (the honest Windows reality)
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'thalos-peer-'));
    const spy = vi.fn(async () => ({
      ok: true,
      output: 'should NOT run',
      patch: { 'x.ts': '1' },
      changedFiles: ['x.ts'],
    }));
    try {
      const result = await runPeerInvoke(req, cwd, { runAdapter: spy });
      expect(result.ok).toBe(false);
      expect(result.output).toMatch(/sandbox/i);
      expect(result.patch).toEqual({}); // nothing produced
      expect(spy).not.toHaveBeenCalled(); // refused BEFORE the adapter — the explicit gate
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('the gate OPENS for a verified peer — the adapter IS reached (the gate is not always-refusing)', async () => {
    setSandbox(confiningSeam); // verified (a seam — proves the gate opens, NOT that it confines)
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'thalos-peer-'));
    const spy = vi.fn(async () => ({
      ok: true,
      output: 'ran',
      patch: { 'x.ts': '1' },
      changedFiles: ['x.ts'],
    }));
    try {
      const result = await runPeerInvoke(req, cwd, { runAdapter: spy });
      expect(spy).toHaveBeenCalledOnce(); // verified ⇒ the adapter is reached
      expect(result.ok).toBe(true);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
