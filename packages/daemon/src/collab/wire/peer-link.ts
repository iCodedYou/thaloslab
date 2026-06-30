// The host-side handle for ONE connected peer. A PeerLink is the ONLY way to push an `invoke` down a
// peer's socket — and it is obtainable solely via `CollabEndpoint.linkFor`, which returns null unless
// the peer is authorized (admitted + active + not revoked). So pushing work to a peer that has not been
// explicitly admitted is STRUCTURALLY impossible: there is no link to push through.
import type { WebSocket } from 'ws';
import { genId } from '../../util/id';
import type { PeerInvokeRequest, PeerResult } from '../protocol';

export class PeerRevokedError extends Error {
  constructor() {
    super('collab peer is not authorized (never admitted, or revoked mid-session)');
    this.name = 'PeerRevokedError';
  }
}

export class PeerInvokeTimeoutError extends Error {
  constructor() {
    super('collab peer did not return a result in time');
    this.name = 'PeerInvokeTimeoutError';
  }
}

/** One in-flight invoke awaiting its correlated `result` frame. */
export interface PendingInvoke {
  resolve: (r: PeerResult) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** A live, post-handshake peer connection. `pending` correlates pushed invokes to their results by id. */
export interface PeerConn {
  peerId: string;
  socket: WebSocket;
  pending: Map<string, PendingInvoke>;
}

export class PeerLink {
  constructor(
    private readonly conn: PeerConn,
    /** Re-checked at push time — checkpoint 2: never push to a peer revoked since the link was obtained. */
    private readonly authorized: () => boolean,
  ) {}

  get peerId(): string {
    return this.conn.peerId;
  }

  invoke(req: PeerInvokeRequest, timeoutMs = 5 * 60_000): Promise<PeerResult> {
    if (!this.authorized()) return Promise.reject(new PeerRevokedError());
    const id = genId('rpc');
    return new Promise<PeerResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.conn.pending.delete(id);
        reject(new PeerInvokeTimeoutError());
      }, timeoutMs);
      this.conn.pending.set(id, { resolve, reject, timer });
      this.conn.socket.send(JSON.stringify({ t: 'invoke', id, req }));
    });
  }
}
