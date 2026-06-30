// Coordinates the pure trust state machine (CollabHost / CollabRuntime) with the real socket
// (CollabEndpoint), so enable/disable/admit/revoke drive BOTH atomically. CollabHost stays a pure,
// deterministic predicate source; this service is the only place that also touches the listener/sockets.
import type { ProviderAdapter } from '@thaloslab/shared';
import { registerAdapter, unregisterPeerAdapters } from '../providers/adapters';
import { peerRoutable } from './protocol';
import { CollabRuntime, collab } from './runtime';
import { collabBindHost, collabPort } from './wire/bind';
import { CollabEndpoint } from './wire/host-endpoint';
import type { PeerLink } from './wire/peer-link';

export class CollabService {
  readonly endpoint: CollabEndpoint;

  constructor(private readonly rt: CollabRuntime = collab) {
    this.endpoint = new CollabEndpoint({
      registerHello: (h) => rt.registerHello(h),
      requestJoin: (id, token) => rt.host.requestJoin(id, token),
      routable: peerRoutable,
      authorized: (id) => rt.host.authorized(id),
    });
  }

  get host() {
    return this.rt.host;
  }
  state() {
    return this.rt.state();
  }
  invite(peerId: string): string {
    return this.rt.host.invite(peerId);
  }

  /** Host consents to pool → open the listener. Bound 127.0.0.1 (off-loopback throws, see bind.ts). */
  async enable(opts: { port?: number } = {}): Promise<number> {
    this.rt.host.enable();
    const host = collabBindHost({ active: true });
    return this.endpoint.start({ host, port: opts.port ?? collabPort() });
  }

  /** Collab off → blanket-revoke every session, close the listener, and drop every pooled provider. */
  async disable(): Promise<void> {
    const peers = this.rt.state().peers.map((p) => p.peerId);
    this.rt.host.disable();
    await this.endpoint.stop();
    for (const peerId of peers) unregisterPeerAdapters(peerId);
  }

  /** The explicit human admit — flips pending → admitted and notifies the parked socket. */
  admit(peerId: string): void {
    this.rt.host.admit(peerId);
    this.endpoint.notifyAdmitted(peerId);
  }

  /**
   * Register a pooled provider for an admitted, routable peer so the router sees `collab:<peer>:<vendor>`
   * exactly while it is admitted. The StageRunner builds the adapter (it has the lane's repo/seam) and
   * registers it here; revoke/disable removes it.
   */
  registerPeerAdapter(adapter: ProviderAdapter): void {
    registerAdapter(adapter);
  }

  /** Revoke → mark revoked, sever the live socket, AND remove every pooled provider from this peer. */
  revoke(peerId: string): void {
    this.rt.host.revoke(peerId);
    this.endpoint.sever(peerId, 'revoked');
    unregisterPeerAdapters(peerId);
  }

  /** A push handle, or null if the peer is not authorized (the structural admit gate). */
  linkFor(peerId: string): PeerLink | null {
    return this.endpoint.linkFor(peerId);
  }
}

/** Production singleton, wrapping the `collab` runtime singleton. */
export const collabService = new CollabService();
