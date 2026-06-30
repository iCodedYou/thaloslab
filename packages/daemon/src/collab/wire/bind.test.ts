// Wire A acceptance: the collab endpoint binds 127.0.0.1 for EVERY state reachable this phase, and the
// off-loopback (LAN/tunnel) opt-in is UNREACHABLE — it throws. This is the proof that adding the wire
// widens nothing: there is no combination of inputs here that binds off-loopback.
import { DAEMON_HOST, DEFAULT_COLLAB_PORT } from '@thaloslab/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { OffLoopbackDeferredError, collabBindHost, collabPort } from './bind';

describe('collabBindHost — loopback-only, off-loopback unreachable this phase', () => {
  it('returns 127.0.0.1 for every loopback-reachable state (idle, active)', () => {
    for (const active of [false, true]) {
      expect(collabBindHost({ active })).toBe('127.0.0.1');
      expect(collabBindHost({ active })).toBe(DAEMON_HOST); // identical to the daemon's bind
    }
  });

  it('THROWS on the off-loopback opt-in (DEFERRED-PENDING-MULTI-MACHINE — never a default, never reachable)', () => {
    expect(() => collabBindHost({ active: true, lanOptIn: true })).toThrow(
      OffLoopbackDeferredError,
    );
    // …and even idle+opt-in throws — there is NO state this phase that yields off-loopback.
    expect(() => collabBindHost({ active: false, lanOptIn: true })).toThrow(
      OffLoopbackDeferredError,
    );
  });
});

describe('collabPort — distinct from the daemon, env-overridable for two-instance tests', () => {
  const saved = process.env.THALOS_COLLAB_PORT;
  afterEach(() => {
    if (saved === undefined) delete process.env.THALOS_COLLAB_PORT;
    else process.env.THALOS_COLLAB_PORT = saved;
  });

  it('defaults to DEFAULT_COLLAB_PORT (8474, not the daemon 8473)', () => {
    delete process.env.THALOS_COLLAB_PORT;
    expect(collabPort()).toBe(DEFAULT_COLLAB_PORT);
    expect(DEFAULT_COLLAB_PORT).not.toBe(8473);
  });

  it('honors THALOS_COLLAB_PORT (and 0 = ephemeral) for two daemons on one machine', () => {
    process.env.THALOS_COLLAB_PORT = '0';
    expect(collabPort()).toBe(0);
    process.env.THALOS_COLLAB_PORT = '9999';
    expect(collabPort()).toBe(9999);
    process.env.THALOS_COLLAB_PORT = 'garbage';
    expect(collabPort()).toBe(DEFAULT_COLLAB_PORT); // invalid → fall back to the default
  });
});
