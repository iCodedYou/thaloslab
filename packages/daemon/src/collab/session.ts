// Axis (d) transport trust. The collab endpoint is SEPARATE from the zero-auth localhost ws.ts and
// binds to LAN/tunnel ONLY while collab is active + the host consents; idle ⇒ 127.0.0.1 only. Join is
// a one-time out-of-band token PLUS an explicit human admit (a valid token alone never authorizes),
// and any session is revocable. The real Fastify endpoint + wire are DEFERRED-PENDING-MULTI-MACHINE;
// this is the deterministic trust state machine the endpoint enforces.
import crypto from 'node:crypto';

interface PeerSession {
  peerId: string;
  token: string;
  tokenUsed: boolean;
  joinRequested: boolean;
  admitted: boolean;
  revoked: boolean;
}

export class CollabHost {
  private sessions = new Map<string, PeerSession>();
  private active = false;

  /** Collab on: only now may the endpoint bind beyond 127.0.0.1 (host consent). */
  enable(): void {
    this.active = true;
  }
  /** Collab off: stop binding the LAN/tunnel endpoint and revoke every session. */
  disable(): void {
    this.active = false;
    for (const s of this.sessions.values()) s.revoked = true;
  }
  isActive(): boolean {
    return this.active;
  }

  /** Issue a one-time join token for an expected peer (delivered out-of-band). */
  invite(peerId: string): string {
    const token = crypto.randomBytes(16).toString('hex');
    this.sessions.set(peerId, {
      peerId,
      token,
      tokenUsed: false,
      joinRequested: false,
      admitted: false,
      revoked: false,
    });
    return token;
  }

  /** A peer presents (peerId, token). Validates + consumes the one-time token. Does NOT authorize —
   *  the host must still explicitly admit. Wrong/used/revoked token ⇒ rejected. */
  requestJoin(peerId: string, token: string): boolean {
    const s = this.sessions.get(peerId);
    if (!s || s.revoked || s.tokenUsed || s.token !== token) return false;
    s.tokenUsed = true;
    s.joinRequested = true;
    return true;
  }

  /** The HOST explicitly admits a peer that presented a valid token (the human "admit" action). */
  admit(peerId: string): boolean {
    const s = this.sessions.get(peerId);
    if (!s || !s.joinRequested || s.revoked) return false;
    s.admitted = true;
    return true;
  }

  revoke(peerId: string): void {
    const s = this.sessions.get(peerId);
    if (s) s.revoked = true;
  }

  /** Authorized for RPC iff collab is active AND the peer was admitted AND not revoked. */
  authorized(peerId: string): boolean {
    if (!this.active) return false;
    const s = this.sessions.get(peerId);
    return !!s && s.admitted && !s.revoked;
  }

  /** The admit/revoke state for the UI — so the human-admit step is explicit + visible. */
  sessionView(peerId: string): {
    exists: boolean;
    joinRequested: boolean;
    admitted: boolean;
    revoked: boolean;
  } {
    const s = this.sessions.get(peerId);
    return {
      exists: !!s,
      joinRequested: !!s?.joinRequested,
      admitted: !!s?.admitted,
      revoked: !!s?.revoked,
    };
  }
}
