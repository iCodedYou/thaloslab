// The SINGLE chokepoint for where the collab endpoint binds — the one place this phase could widen the
// 127.0.0.1-only trust boundary, so it is deliberately tiny and fail-closed.
//
// This phase proves the wire two-process ON ONE MACHINE, entirely over loopback. Binding off-loopback
// (0.0.0.0 / a LAN interface / a tunnel) is what actually exposes the daemon to other machines — and
// that is DEFERRED-PENDING-MULTI-MACHINE. So off-loopback is not merely "not the default": it is
// UNREACHABLE here — the opt-in branch THROWS. Off-loopback will require, together, collab-active +
// host-consent + an explicit LAN/tunnel opt-in, and that whole path is the deferred phase's entry point.
import { DAEMON_HOST, DEFAULT_COLLAB_PORT } from '@thaloslab/shared';

/** The port the collab endpoint prefers; `THALOS_COLLAB_PORT` overrides (mirrors `THALOS_DB_PATH`), so
 *  two instances on one machine can each pick a free port for testing. */
export function collabPort(): number {
  const env = process.env.THALOS_COLLAB_PORT;
  const n = env ? Number(env) : Number.NaN;
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : DEFAULT_COLLAB_PORT;
}

export interface CollabBindState {
  /** Collab is enabled (host consented to pool). */
  active: boolean;
  /** The explicit LAN/tunnel opt-in. DEFERRED-PENDING-MULTI-MACHINE: setting it here THROWS. */
  lanOptIn?: boolean;
}

/** Thrown if anyone tries to bind the collab endpoint off-loopback this phase. The off-loopback path is
 *  DEFERRED-PENDING-MULTI-MACHINE — a real second machine must run the suite before it is implemented. */
export class OffLoopbackDeferredError extends Error {
  constructor() {
    super(
      'off-loopback collab bind (LAN/tunnel) is DEFERRED-PENDING-MULTI-MACHINE — the wire is proven on ' +
        '127.0.0.1 two-process; cross-host networking is not yet implemented',
    );
    this.name = 'OffLoopbackDeferredError';
  }
}

/**
 * The host the collab endpoint binds to. This phase returns `127.0.0.1` for EVERY reachable state; the
 * off-loopback branch throws. The fail-closed posture is thus testable: there is no combination of
 * inputs available this phase that yields anything but loopback.
 */
export function collabBindHost(state: CollabBindState): string {
  if (state.lanOptIn) throw new OffLoopbackDeferredError(); // unreachable this phase, by design
  return DAEMON_HOST; // 127.0.0.1 — identical to the daemon; the wire widens nothing
}
