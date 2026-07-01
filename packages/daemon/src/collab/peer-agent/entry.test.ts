// F1 — the peer-agent ENTRYPOINT proven through the PRODUCTION path (connectPeerAgent), over a real
// socket, on THIS Windows host. Two claims, kept distinct:
//  (A) AXIS 1 through the real entry: this machine's HONEST self-test is Noop (ok:false) → the host
//      REFUSES the join. Not the test harness reconstructing the peer — the actual production function.
//  (B) MUTATION proof that the refusal is VERDICT-DRIVEN, not hardcoded: change ONLY the sandbox verdict
//      (Noop → a verified seam) and the SAME entry + SAME host parks on pending instead of refusing. If a
//      faked-verified hello were admitted while the honest one is refused, the gate is real — the refusal
//      follows from the self-test reaching the host's peerRoutable gate, nothing hardcodes a reject.
import type { Sandbox } from '@thaloslab/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { resetSandbox, setSandbox } from '../../providers/sandbox';
import { CollabService } from '../collab-service';
import { CollabRuntime } from '../runtime';
import { connectPeerAgent, parsePeerArgs } from './index';

// A test-seam "verified" backend: makes the peer ADMITTABLE without confining anything (identity wrap).
// Stands in for the real jail (bubblewrap = VERIFIED-ON-LINUX, sandbox-exec = VERIFIED-ON-MACOS). Here it
// exists ONLY to flip the self-test verdict for the mutation proof — the WIRE is what F1 exercises.
const verifiedSeam: Sandbox = {
  id: 'bubblewrap',
  detect: async () => ({ available: true, version: 'seam' }),
  capabilities: () => ['fs-scope', 'network-none'],
  selfTest: async () => ({
    ok: true,
    fsBlocked: true,
    netBlocked: true,
    proof: 'SEAM — not a real jail',
    id: 'bubblewrap',
    os: 'linux',
    verifiedAt: 0,
  }),
  wrap: (cmd, args) => ({ cmd, args }),
};

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  resetSandbox();
});

async function standUpHost(
  peerId: string,
): Promise<{ url: string; svc: CollabService; token: string }> {
  const svc = new CollabService(new CollabRuntime());
  const port = await svc.enable({ port: 0 }); // ephemeral loopback
  const token = svc.invite(peerId);
  cleanups.push(async () => svc.disable());
  return { url: `ws://127.0.0.1:${port}`, svc, token };
}

describe('peer-agent entrypoint — Axis 1 through the production path (real socket)', () => {
  it('(A) honest Noop self-test on Windows → advertised as-is → REFUSED at join over the real socket', async () => {
    resetSandbox(); // the REAL platform sandbox here (Windows) is NoopSandbox ⇒ self-test ok:false
    const { url, token } = await standUpHost('win-1');

    const conn = await connectPeerAgent({ url, peerId: 'win-1', token });
    expect(conn.hello.sandbox?.ok).toBe(false); // advertised HONESTLY (not faked)
    expect(conn.outcome).toBe('rejected'); // the host refused
    expect(conn.reason ?? '').toMatch(/sandbox/i); // ...specifically: no verified sandbox (Axis 1)
    conn.handle.close();
  });

  it('(B) MUTATION: flip ONLY the self-test verdict → the SAME entry parks on pending (refusal was verdict-driven)', async () => {
    setSandbox(verifiedSeam); // same entry, same host — ONLY the sandbox verdict changes to ok:true
    const { url, svc, token } = await standUpHost('mac-sim');

    const conn = await connectPeerAgent({ url, peerId: 'mac-sim', token });
    expect(conn.hello.sandbox?.ok).toBe(true); // now verified
    expect(conn.outcome).toBe('pending'); // NOT rejected — token + verified ⇒ parked awaiting admit
    // and the token STILL does not authorize: only the explicit human admit advances it.
    svc.admit('mac-sim');
    expect((await conn.handle.next()).t).toBe('join.admitted');
    conn.handle.close();
  });
});

describe('peer-agent arg resolution', () => {
  it('flags first, then env; fails LOUD when a required input is missing (never a hardcoded host/token)', () => {
    expect(parsePeerArgs(['--host', 'ws://h', '--token', 't', '--peer-id', 'p'], {})).toEqual({
      url: 'ws://h',
      token: 't',
      peerId: 'p',
      cwd: undefined,
    });
    expect(
      parsePeerArgs([], {
        THALOS_COLLAB_HOST: 'ws://e',
        THALOS_COLLAB_TOKEN: 'te',
        THALOS_PEER_ID: 'pe',
      }),
    ).toMatchObject({ url: 'ws://e', token: 'te', peerId: 'pe' });
    expect(() => parsePeerArgs(['--host', 'ws://h'], {})).toThrow(/missing required/i);
  });
});
