// The host-side collab WS endpoint (SPEC §11) — a SEPARATE listener from the zero-auth `/ws`. The peer
// dials in; the host runs the join handshake (token → explicit admit), pushes invokes, and re-checks
// `authorized()` on EVERY frame so a mid-session revoke severs the live socket. It owns no trust state —
// it consumes the pure `CollabHost` predicates via its deps. Bound 127.0.0.1 only (see bind.ts).
import { type WebSocket, WebSocketServer } from 'ws';
import type { PeerHello } from '../protocol';
import { COLLAB_CLOSE, type CollabFrame, type HostToPeer, parseFrame } from './frames';
import { PeerLink, type PeerConn, PeerRevokedError } from './peer-link';

export interface EndpointDeps {
  registerHello: (hello: PeerHello) => void;
  /** Validates + consumes the one-time token (does NOT authorize — admit is separate). */
  requestJoin: (peerId: string, token: string) => boolean;
  /** Sandbox-required: a peer with no verified self-test is refused at join (Axis 1). */
  routable: (hello: PeerHello) => boolean;
  /** active && admitted && !revoked — the single authorization predicate. */
  authorized: (peerId: string) => boolean;
}

const HANDSHAKE_MS = 5_000;

function send(socket: WebSocket, frame: HostToPeer): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
}

export class CollabEndpoint {
  private wss: WebSocketServer | null = null;
  private boundPort: number | null = null;
  private readonly conns = new Map<string, PeerConn>();

  constructor(private readonly deps: EndpointDeps) {}

  get listening(): boolean {
    return this.wss !== null;
  }

  /** The port the listener is bound to (null when not listening) — for the API/UI to surface. */
  get port(): number | null {
    return this.boundPort;
  }

  start(opts: { host: string; port: number }): Promise<number> {
    if (this.wss) throw new Error('collab endpoint already started');
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ host: opts.host, port: opts.port });
      wss.on('connection', (socket) => this.onConnection(socket));
      wss.once('error', reject);
      wss.once('listening', () => {
        wss.off('error', reject);
        this.wss = wss;
        const addr = wss.address();
        this.boundPort = typeof addr === 'object' && addr ? addr.port : opts.port;
        resolve(this.boundPort);
      });
    });
  }

  private onConnection(socket: WebSocket): void {
    let peerId: string | null = null;
    const hs = setTimeout(
      () => socket.close(COLLAB_CLOSE.PROTOCOL, 'handshake timeout'),
      HANDSHAKE_MS,
    );

    socket.on('message', (raw: Buffer) => {
      const frame = parseFrame(raw.toString());
      if (!frame) {
        socket.close(COLLAB_CLOSE.PROTOCOL, 'malformed frame');
        return;
      }
      if (peerId === null) {
        // Pre-handshake: the FIRST frame must be `join`.
        if (frame.t !== 'join') {
          socket.close(COLLAB_CLOSE.PROTOCOL, 'expected join');
          return;
        }
        clearTimeout(hs);
        this.deps.registerHello(frame.hello);
        if (!this.deps.requestJoin(frame.peerId, frame.token)) {
          send(socket, { t: 'join.rejected', reason: 'bad or used token' });
          socket.close(COLLAB_CLOSE.UNAUTHENTICATED, 'token');
          return;
        }
        if (!this.deps.routable(frame.hello)) {
          // Axis 1, at the socket layer: no verified sandbox ⇒ refused before any invoke is possible.
          send(socket, { t: 'join.rejected', reason: 'no verified sandbox' });
          socket.close(COLLAB_CLOSE.UNAUTHORIZED, 'sandbox');
          return;
        }
        peerId = frame.peerId;
        this.conns.set(peerId, { peerId, socket, pending: new Map() });
        send(socket, { t: 'join.pending' }); // PARK — token alone never authorizes; await admit
        if (this.deps.authorized(peerId)) send(socket, { t: 'join.admitted' });
        return;
      }
      // Post-handshake: EVERY frame requires authorization (checkpoint 1) — drop+sever before effect.
      if (!this.deps.authorized(peerId)) {
        this.sever(peerId, 'unauthorized');
        return;
      }
      this.onAuthedFrame(peerId, frame);
    });

    socket.on('close', () => {
      if (peerId) this.conns.delete(peerId);
    });
    socket.on('error', () => {
      /* the close handler does cleanup */
    });
  }

  private onAuthedFrame(peerId: string, frame: CollabFrame): void {
    const conn = this.conns.get(peerId);
    if (!conn) return;
    if (frame.t === 'result') {
      if (!this.deps.authorized(peerId)) {
        this.sever(peerId, 'unauthorized'); // checkpoint 3: never accept a result from a revoked peer
        return;
      }
      const pending = conn.pending.get(frame.id);
      if (pending) {
        clearTimeout(pending.timer);
        conn.pending.delete(frame.id);
        pending.resolve(frame.result);
      }
    } else if (frame.t === 'bye') {
      this.dropConn(peerId);
    }
    // `stream` is advisory (forwarded in Wire D); a post-handshake `join` is ignored.
  }

  /** Notify a parked peer that the host has explicitly admitted it (pending → admitted). */
  notifyAdmitted(peerId: string): void {
    const conn = this.conns.get(peerId);
    if (conn && this.deps.authorized(peerId)) send(conn.socket, { t: 'join.admitted' });
  }

  /** A push handle, but ONLY for an authorized peer — null otherwise (the structural admit gate). */
  linkFor(peerId: string): PeerLink | null {
    const conn = this.conns.get(peerId);
    if (!conn || !this.deps.authorized(peerId)) return null;
    return new PeerLink(conn, () => this.deps.authorized(peerId));
  }

  /** Force-close a live session: reject any in-flight invoke, say bye, close the socket. */
  sever(peerId: string, reason: string): void {
    const conn = this.conns.get(peerId);
    if (!conn) return;
    this.rejectPending(conn);
    send(conn.socket, { t: 'bye', reason });
    conn.socket.close(COLLAB_CLOSE.UNAUTHORIZED, reason);
    this.conns.delete(peerId);
  }

  private dropConn(peerId: string): void {
    const conn = this.conns.get(peerId);
    if (!conn) return;
    this.rejectPending(conn);
    conn.socket.close();
    this.conns.delete(peerId);
  }

  private rejectPending(conn: PeerConn): void {
    for (const p of conn.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new PeerRevokedError());
    }
    conn.pending.clear();
  }

  /** Sever all live sockets and CLOSE the listener — the collab port is released (back to no-listener). */
  async stop(): Promise<void> {
    for (const peerId of [...this.conns.keys()]) this.sever(peerId, 'collab disabled');
    const wss = this.wss;
    this.wss = null;
    this.boundPort = null;
    if (!wss) return;
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }
}
