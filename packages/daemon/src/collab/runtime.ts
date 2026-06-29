// The process-wide collab runtime: the CollabHost trust state machine + the registry of connected
// peers' advertisements, exposed as a serializable state for the API/UI. The admit step is ALWAYS an
// explicit host action (a valid token alone never authorizes) — the UI surfaces that, not an
// auto-admit. The real cross-machine wire that populates `registerHello` is DEFERRED-PENDING-MULTI-MACHINE.
import type { PeerHello } from './protocol';
import { peerRoutable } from './protocol';
import { CollabHost } from './session';

export interface CollabPeerView {
  peerId: string;
  vendors: string[];
  /** The peer's OWN sandbox self-test passed → it can safely run the host's task (axis 1). */
  sandboxOk: boolean;
  joinRequested: boolean;
  admitted: boolean;
  revoked: boolean;
  /** Eligible to receive pooled work right now: sandbox-verified AND admitted AND collab active. */
  routable: boolean;
}

export interface CollabState {
  active: boolean;
  peers: CollabPeerView[];
}

export class CollabRuntime {
  readonly host = new CollabHost();
  private hellos = new Map<string, PeerHello>();

  registerHello(hello: PeerHello): void {
    this.hellos.set(hello.peerId, hello);
  }

  state(): CollabState {
    return {
      active: this.host.isActive(),
      peers: [...this.hellos.values()].map((h) => {
        const s = this.host.sessionView(h.peerId);
        return {
          peerId: h.peerId,
          vendors: h.cliProviders.map((c) => c.vendor),
          sandboxOk: peerRoutable(h), // a verified peer-side jail (axis 1, fail-closed)
          joinRequested: s.joinRequested,
          admitted: s.admitted,
          revoked: s.revoked,
          routable: peerRoutable(h) && this.host.authorized(h.peerId),
        };
      }),
    };
  }
}

/** The singleton used by the server routes. */
export const collab = new CollabRuntime();
