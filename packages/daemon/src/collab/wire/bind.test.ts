// F2 acceptance — the fail-closed off-loopback bind, proven DETERMINISTICALLY before any real socket
// exists (same discipline as Wire A). The bind is the whole trust-boundary story, so the teeth are here:
//  - loopback by default (no opt-in);
//  - tailnet exposure binds ONLY to a discovered 100.64/10 (Tailscale) address;
//  - THROWS (no fallback) when no tailnet interface exists — the guarantee it can't silently widen;
//  - 0.0.0.0 / all-interfaces is NEVER returnable under ANY input;
//  - tailnet exposure requires active consent.
// Interfaces are INJECTED (a fake provider) — no real tailnet, no socket.
import type os from 'node:os';
import { DAEMON_HOST, DEFAULT_COLLAB_PORT } from '@thaloslab/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type InterfaceProvider,
  TailnetExposureWithoutConsentError,
  TailscaleInterfaceNotFoundError,
  collabBindHost,
  collabPort,
  isTailscaleCgnat,
  resolveTailscaleAddress,
} from './bind';

// Fake interface tables. NOTE they include 0.0.0.0 and a PUBLIC 100.x (100.200.x, OUTSIDE 100.64/10) as
// traps — a correct resolver must pick ONLY the CGNAT address and never these.
const v4 = (address: string, internal = false): os.NetworkInterfaceInfo =>
  ({
    address,
    family: 'IPv4',
    internal,
    netmask: '',
    mac: '',
    cidr: null,
  }) as os.NetworkInterfaceInfo;

const withTailscale: InterfaceProvider = () => ({
  lo: [v4('127.0.0.1', true)],
  eth0: [v4('192.168.1.50')],
  wan: [v4('0.0.0.0')], // trap: all-interfaces sentinel
  pub: [v4('100.200.5.5')], // trap: 100.x but NOT in 100.64/10 (public), must be excluded
  Tailscale: [v4('100.101.102.103')], // the real CGNAT address
});
const noTailscale: InterfaceProvider = () => ({
  lo: [v4('127.0.0.1', true)],
  eth0: [v4('192.168.1.50')],
  wan: [v4('0.0.0.0')],
  pub: [v4('100.200.5.5')], // a public 100.x is NOT a tailnet — must still THROW
});

describe('collabBindHost — loopback default; tailnet fail-closed; 0.0.0.0 never returnable', () => {
  it('returns 127.0.0.1 for every state WITHOUT the tailnet opt-in (default stays loopback)', () => {
    for (const active of [false, true]) {
      expect(collabBindHost({ active }, withTailscale)).toBe('127.0.0.1');
      expect(collabBindHost({ active, exposure: 'loopback' }, withTailscale)).toBe(DAEMON_HOST);
    }
  });

  it('tailnet + active → binds the discovered 100.64/10 Tailscale address (NOT the public 100.x, NOT 0.0.0.0)', () => {
    expect(collabBindHost({ active: true, exposure: 'tailnet' }, withTailscale)).toBe(
      '100.101.102.103',
    );
  });

  it('tailnet requested but NO tailnet interface → THROWS (fail-closed, NO fallback to a broader bind)', () => {
    expect(() => collabBindHost({ active: true, exposure: 'tailnet' }, noTailscale)).toThrow(
      TailscaleInterfaceNotFoundError,
    );
  });

  it('tailnet WITHOUT active consent → THROWS (off-loopback needs pool consent too)', () => {
    expect(() => collabBindHost({ active: false, exposure: 'tailnet' }, withTailscale)).toThrow(
      TailnetExposureWithoutConsentError,
    );
  });

  it('0.0.0.0 / all-interfaces is NEVER returnable under ANY input combination', () => {
    const inputs: Array<Parameters<typeof collabBindHost>[0]> = [
      { active: false },
      { active: true },
      { active: false, exposure: 'loopback' },
      { active: true, exposure: 'loopback' },
      { active: true, exposure: 'tailnet' },
    ];
    for (const provider of [withTailscale, noTailscale]) {
      for (const input of inputs) {
        let host: string | null = null;
        try {
          host = collabBindHost(input, provider);
        } catch {
          host = null; // a throw is a fail-closed outcome — also acceptable, just not a widened bind
        }
        expect(host).not.toBe('0.0.0.0');
        expect(host === null || host === '127.0.0.1' || isTailscaleCgnat(host)).toBe(true);
      }
    }
  });
});

describe('resolveTailscaleAddress + isTailscaleCgnat — range math', () => {
  it('accepts 100.64.0.0/10 (100.64.x – 100.127.x), rejects public 100.x and non-100 nets', () => {
    expect(isTailscaleCgnat('100.64.0.1')).toBe(true);
    expect(isTailscaleCgnat('100.127.255.254')).toBe(true);
    expect(isTailscaleCgnat('100.101.102.103')).toBe(true);
    expect(isTailscaleCgnat('100.63.0.1')).toBe(false); // just below the range
    expect(isTailscaleCgnat('100.128.0.1')).toBe(false); // just above the range
    expect(isTailscaleCgnat('100.200.5.5')).toBe(false); // public 100.x
    expect(isTailscaleCgnat('192.168.1.1')).toBe(false);
    expect(isTailscaleCgnat('0.0.0.0')).toBe(false);
  });

  it('resolver ignores loopback/internal + non-CGNAT and returns the CGNAT address, else THROWS', () => {
    expect(resolveTailscaleAddress(withTailscale)).toBe('100.101.102.103');
    expect(() => resolveTailscaleAddress(noTailscale)).toThrow(TailscaleInterfaceNotFoundError);
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
