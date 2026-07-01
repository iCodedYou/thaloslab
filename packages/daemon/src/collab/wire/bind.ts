// The SINGLE chokepoint for where the collab endpoint binds — the one place that can widen the
// 127.0.0.1-only trust boundary, so it is deliberately tiny and FAIL-CLOSED. The default is loopback.
// Off-loopback is reachable ONLY as an explicit `exposure: 'tailnet'` consent AND only to the host's own
// Tailscale interface (the 100.64.0.0/10 CGNAT range) — NEVER 0.0.0.0 / all-interfaces, never the public
// internet. If tailnet exposure is requested but no Tailscale interface exists, this THROWS — it does NOT
// fall back to a broader bind. That throw is the whole guarantee that the wire cannot silently widen.
//
// Two claims kept distinct: this makes the tailnet BIND reachable + fail-closed; a real cross-machine
// round-trip over it is F3 (DEFERRED-PENDING-MULTI-MACHINE) until a second machine runs the suite.
import os from 'node:os';
import { DAEMON_HOST, DEFAULT_COLLAB_PORT } from '@thaloslab/shared';

/** The port the collab endpoint prefers; `THALOS_COLLAB_PORT` overrides (mirrors `THALOS_DB_PATH`), so
 *  two instances on one machine can each pick a free port for testing. */
export function collabPort(): number {
  const env = process.env.THALOS_COLLAB_PORT;
  const n = env ? Number(env) : Number.NaN;
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : DEFAULT_COLLAB_PORT;
}

/** Where the collab endpoint may be exposed. `loopback` (default) = 127.0.0.1; `tailnet` = the host's
 *  own Tailscale interface, and NOTHING wider. There is no `lan`/`0.0.0.0`/public value — by design. */
export type CollabExposure = 'loopback' | 'tailnet';

export interface CollabBindState {
  /** Collab is enabled (host consented to pool). */
  active: boolean;
  /** The explicit off-loopback consent. `tailnet` binds to the Tailscale interface; absent/`loopback`
   *  stays 127.0.0.1. Requires `active` — exposure without consent-to-pool THROWS. */
  exposure?: CollabExposure;
}

/** A source of network interfaces — injectable so the fail-closed logic is unit-testable without a real
 *  tailnet (defaults to the real `os.networkInterfaces`). */
export type InterfaceProvider = () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;

/** Thrown when tailnet exposure is requested but NO Tailscale (100.64.0.0/10) interface is present. The
 *  endpoint refuses to start rather than falling back to a broader bind — fail-closed, never widen. */
export class TailscaleInterfaceNotFoundError extends Error {
  constructor() {
    super(
      'collab tailnet exposure requested but no Tailscale interface (100.64.0.0/10) was found — refusing ' +
        'to bind (fail-closed: never falls back to a broader/all-interfaces bind). Is Tailscale up?',
    );
    this.name = 'TailscaleInterfaceNotFoundError';
  }
}

/** Thrown when tailnet exposure is requested without collab being active — off-loopback requires BOTH the
 *  pool consent (`active`) AND the explicit tailnet consent. */
export class TailnetExposureWithoutConsentError extends Error {
  constructor() {
    super(
      'collab tailnet exposure requires collab to be active (consent-to-pool) — refusing to bind',
    );
    this.name = 'TailnetExposureWithoutConsentError';
  }
}

/** True iff `addr` is in the Tailscale CGNAT range 100.64.0.0/10 (100.64.x – 100.127.x). Range-matching
 *  is interface-name-independent (Tailscale is `utun*` on macOS, `tailscale0` on Linux, `Tailscale` on
 *  Windows). A public 100.x (e.g. 100.200.x) is NOT in /10 and is correctly excluded. */
export function isTailscaleCgnat(addr: string): boolean {
  const parts = addr.split('.');
  if (parts.length !== 4) return false;
  const o1 = Number(parts[0]);
  const o2 = Number(parts[1]);
  return o1 === 100 && o2 >= 64 && o2 <= 127;
}

/** Resolve the host's Tailscale interface address (IPv4, non-internal, in 100.64.0.0/10), or THROW. This
 *  is the ONLY function that can return an off-loopback value — and it can only return a discovered CGNAT
 *  address, never 0.0.0.0 and never a fallback. */
export function resolveTailscaleAddress(
  interfaces: InterfaceProvider = os.networkInterfaces,
): string {
  for (const infos of Object.values(interfaces())) {
    for (const info of infos ?? []) {
      // Node reports family as 'IPv4' (>=18) or 4 (older) — accept both.
      const isV4 = info.family === 'IPv4' || (info.family as unknown) === 4;
      if (isV4 && !info.internal && isTailscaleCgnat(info.address)) return info.address;
    }
  }
  throw new TailscaleInterfaceNotFoundError();
}

/**
 * The host the collab endpoint binds to. Loopback (127.0.0.1) unless `exposure: 'tailnet'` is explicitly
 * consented AND collab is active — in which case it returns the discovered Tailscale (100.64/10) address,
 * or THROWS if none exists. There is NO input that yields 0.0.0.0 / all-interfaces: the only off-loopback
 * value obtainable is a real Tailscale CGNAT address.
 */
export function collabBindHost(
  state: CollabBindState,
  interfaces: InterfaceProvider = os.networkInterfaces,
): string {
  if (state.exposure === 'tailnet') {
    if (!state.active) throw new TailnetExposureWithoutConsentError();
    return resolveTailscaleAddress(interfaces); // 100.64/10 or THROW — never a broader/fallback bind
  }
  return DAEMON_HOST; // 127.0.0.1 — the default; the wire widens nothing without explicit tailnet consent
}
