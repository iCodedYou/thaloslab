// The collab WS-RPC envelope (SPEC §11). One persistent authenticated socket per peer; the PEER dials
// the HOST (the peer is behind NAT — the host exposes the endpoint), the host PUSHES `invoke` and the
// peer streams back `result`, correlated by `id`. `PeerHello`/`PeerInvokeRequest`/`PeerResult` are reused
// VERBATIM from protocol.ts as payloads — this module only adds the framing + handshake states.
import type { ProviderEvent } from '@thaloslab/shared';
import type { PeerHello, PeerInvokeRequest, PeerResult } from '../protocol';

/** WS close codes (4xxx = application). */
export const COLLAB_CLOSE = {
  /** malformed/unexpected frame, or no `join` within the handshake window */
  PROTOCOL: 4400,
  /** bad/used/revoked token — the one-time token failed `requestJoin` */
  UNAUTHENTICATED: 4401,
  /** authenticated but not authorized: no verified sandbox, not admitted, or revoked */
  UNAUTHORIZED: 4403,
} as const;

// ---- peer → host ----

/** First frame, exactly once. Carries the one-time token AND the peer's advertisement (incl. its OWN
 *  sandbox self-test — a null/!ok self-test ⇒ the host refuses, fail-closed). */
export interface JoinFrame {
  t: 'join';
  peerId: string;
  token: string;
  hello: PeerHello;
}

/** Correlated streaming output from a running invoke (advisory, like an adapter's stdout). */
export interface StreamFrame {
  t: 'stream';
  id: string;
  event: ProviderEvent;
}

/** The terminal response to one `invoke`. `result.ok`/`result.changedFiles` are ADVISORY — the host
 *  re-derives both from its own git after quarantine. */
export interface ResultFrame {
  t: 'result';
  id: string;
  result: PeerResult;
}

// ---- host → peer ----

/** Token consumed + sandbox-verified, but parked awaiting the explicit human admit (token alone never
 *  authorizes). No `invoke` can arrive in this state. */
export interface JoinPendingFrame {
  t: 'join.pending';
}

/** The host explicitly admitted the peer (and collab is active) — `authorized` is now true. */
export interface JoinAdmittedFrame {
  t: 'join.admitted';
}

/** Join refused: bad/used token, no verified sandbox, or revoked. The socket then closes. */
export interface JoinRejectedFrame {
  t: 'join.rejected';
  reason: string;
}

/** The host pushes a scoped invocation down the peer-initiated socket. */
export interface InvokeFrame {
  t: 'invoke';
  id: string;
  req: PeerInvokeRequest;
}

// ---- either direction ----

export interface ErrorFrame {
  t: 'error';
  id?: string;
  code: string;
  message: string;
}

/** Graceful sever: host on revoke/disable, peer on clean exit. */
export interface ByeFrame {
  t: 'bye';
  reason: string;
}

export type PeerToHost = JoinFrame | StreamFrame | ResultFrame | ErrorFrame | ByeFrame;
export type HostToPeer =
  JoinPendingFrame | JoinAdmittedFrame | JoinRejectedFrame | InvokeFrame | ErrorFrame | ByeFrame;
export type CollabFrame = PeerToHost | HostToPeer;

/** Parse a raw socket message into a frame, or null if it isn't well-formed JSON with a string `t`
 *  (fail-closed: an unparseable frame is never treated as a valid one). */
export function parseFrame(raw: string): CollabFrame | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || typeof (obj as { t?: unknown }).t !== 'string')
    return null;
  return obj as CollabFrame;
}
