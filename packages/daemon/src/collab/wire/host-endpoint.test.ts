// Wire B acceptance: the trust state machine drives a REAL socket. Driven by a bare `ws` client (no real
// peer yet) — the auth/admit/revoke/sever behaviour IS the point. Mirrors the in-process CollabHost test
// (collab-trust.test.ts) but over `CollabEndpoint.listen(0)`. The happy round-trip is Wire D; here we
// prove: token-alone-never-authorizes (invoke STRUCTURALLY impossible before admit), explicit admit flips
// the gate, revoke severs a live session, disable closes the listener, and a per-frame auth check drops
// an unsolicited frame from an unauthorized peer.
import type { SelfTestResult, ToolPolicy } from '@thaloslab/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { CollabRuntime } from '../runtime';
import { CollabService } from '../collab-service';
import { PeerRevokedError } from './peer-link';

const okSelfTest: SelfTestResult = {
  ok: true,
  fsBlocked: true,
  netBlocked: true,
  proof: 'denied',
  id: 'bubblewrap',
  os: 'linux',
  verifiedAt: 0,
};
const helloOk = (peerId: string) => ({
  peerId,
  cliProviders: [{ id: 'codex', vendor: 'codex' as const, authenticated: true }],
  sandbox: okSelfTest,
});
const helloNoSandbox = (peerId: string) => ({ ...helloOk(peerId), sandbox: null });

const policy: ToolPolicy = {
  canRead: true,
  canWrite: true,
  canExecCommands: true,
  network: 'none',
  pathScope: 'own-worktree',
};
const sampleReq = { policy, providerId: 'codex', prompt: 'x', contextManifest: [], files: [] };

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

/** A buffered frame reader: returns next() that resolves the next parsed frame (buffering if ahead). */
function frames(ws: WebSocket): () => Promise<{ t: string; [k: string]: unknown }> {
  const q: Array<{ t: string }> = [];
  const waiters: Array<(f: { t: string }) => void> = [];
  ws.on('message', (raw: Buffer) => {
    const f = JSON.parse(raw.toString());
    const w = waiters.shift();
    if (w) w(f);
    else q.push(f);
  });
  return () =>
    q.length ? Promise.resolve(q.shift()!) : new Promise((res) => waiters.push(res as () => void));
}
function closeCode(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.once('close', (code) => resolve(code)));
}

describe('Wire B — the trust state machine drives a real socket', () => {
  let svc: CollabService;
  let port: number;
  const open: WebSocket[] = [];

  beforeEach(async () => {
    svc = new CollabService(new CollabRuntime());
    port = await svc.enable({ port: 0 }); // real ephemeral loopback socket
  });
  afterEach(async () => {
    for (const ws of open.splice(0)) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    await svc.disable();
  });
  const track = (ws: WebSocket) => (open.push(ws), ws);

  it('token-without-admit: a valid token PARKS on pending and NO invoke is structurally possible', async () => {
    const token = svc.invite('peerB');
    const ws = track(await connect(port));
    const next = frames(ws);
    ws.send(JSON.stringify({ t: 'join', peerId: 'peerB', token, hello: helloOk('peerB') }));

    expect(await next()).toEqual({ t: 'join.pending' });
    expect(svc.host.authorized('peerB')).toBe(false);
    // STRUCTURAL: the only way to push an invoke is a PeerLink, and there is none before admit.
    expect(svc.linkFor('peerB')).toBeNull();
  });

  it('the explicit human admit() flips pending → admitted (valid token necessary, NOT sufficient)', async () => {
    const token = svc.invite('peerB');
    const ws = track(await connect(port));
    const next = frames(ws);
    ws.send(JSON.stringify({ t: 'join', peerId: 'peerB', token, hello: helloOk('peerB') }));
    expect(await next()).toEqual({ t: 'join.pending' });
    expect(svc.linkFor('peerB')).toBeNull(); // still no link

    svc.admit('peerB'); // the explicit human action

    expect(await next()).toEqual({ t: 'join.admitted' });
    expect(svc.host.authorized('peerB')).toBe(true);
    expect(svc.linkFor('peerB')).not.toBeNull(); // NOW an invoke is possible
  });

  it('a bad/used token is rejected (cannot join)', async () => {
    svc.invite('peerB');
    const ws = track(await connect(port));
    const next = frames(ws);
    ws.send(
      JSON.stringify({ t: 'join', peerId: 'peerB', token: 'wrong', hello: helloOk('peerB') }),
    );
    expect((await next()).t).toBe('join.rejected');
    expect(await closeCode(ws)).toBe(4401);
  });

  it('Axis 1 at the socket: a peer with no verified sandbox is refused at join', async () => {
    const token = svc.invite('peerX');
    const ws = track(await connect(port));
    const next = frames(ws);
    ws.send(JSON.stringify({ t: 'join', peerId: 'peerX', token, hello: helloNoSandbox('peerX') }));
    const f = await next();
    expect(f.t).toBe('join.rejected');
    expect(String(f.reason)).toContain('sandbox');
    expect(await closeCode(ws)).toBe(4403);
  });

  it('revoke SEVERS a live session: the in-flight invoke rejects and the socket is closed', async () => {
    const token = svc.invite('peerB');
    const ws = track(await connect(port));
    const next = frames(ws);
    ws.send(JSON.stringify({ t: 'join', peerId: 'peerB', token, hello: helloOk('peerB') }));
    await next(); // pending
    svc.admit('peerB');
    await next(); // admitted

    const link = svc.linkFor('peerB');
    expect(link).not.toBeNull();
    const invokeP = link!.invoke(sampleReq, 10_000);
    expect((await next()).t).toBe('invoke'); // the push actually went down the wire

    svc.revoke('peerB'); // revoke MID-SESSION

    await expect(invokeP).rejects.toBeInstanceOf(PeerRevokedError); // in-flight rejects
    expect(await closeCode(ws)).toBe(4403); // the open socket is severed
    expect(svc.linkFor('peerB')).toBeNull(); // and no new invoke is possible
  });

  it('a parked (not-admitted) peer that slips an unsolicited result frame is dropped + severed', async () => {
    const token = svc.invite('peerB');
    const ws = track(await connect(port));
    const next = frames(ws);
    ws.send(JSON.stringify({ t: 'join', peerId: 'peerB', token, hello: helloOk('peerB') }));
    await next(); // pending — NOT admitted
    // The peer tries to push a result without ever being admitted → per-frame auth drops + severs.
    ws.send(
      JSON.stringify({
        t: 'result',
        id: 'x',
        result: { ok: true, output: '', patch: {}, changedFiles: [] },
      }),
    );
    expect(await closeCode(ws)).toBe(4403);
  });

  it('disable() CLOSES the listener — the collab port no longer accepts connections (no listener)', async () => {
    expect(svc.endpoint.listening).toBe(true);
    await svc.disable();
    expect(svc.endpoint.listening).toBe(false);
    await expect(connect(port)).rejects.toBeTruthy(); // ECONNREFUSED — there is no listener
  });
});
