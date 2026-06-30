// The collab peer-agent (SPEC §11) — a LIGHTWEIGHT, DB-less outbound WS client. It is NOT a daemon: no
// projects/tickets DB, no lockfile, no Fastify, no workflow engine. It self-tests its OWN sandbox,
// advertises that honestly, dials the host, and on an `invoke` re-derives its policy and runs the task
// in `--mock` (deterministic, zero tokens), returning a patch. The host's policy is ADVISORY — the peer
// protects ITSELF from the host's task.
import fs from 'node:fs';
import path from 'node:path';
import type { ProviderId, SelfTestResult } from '@thaloslab/shared';
import { WebSocket } from 'ws';
import { adapterFor } from '../../providers/adapters';
import { detectSandbox, resolveSandboxBinding, verifiedSelfTest } from '../../providers/sandbox';
import type { PeerHello, PeerInvokeRequest, PeerResult } from '../protocol';
import { type CollabFrame, parseFrame } from '../wire/frames';

/**
 * The peer's HONEST sandbox self-test — the REAL `detectSandbox` + `verifiedSelfTest` for THIS machine.
 * Nothing forces the verdict: on a box with no real jail (Windows → NoopSandbox) it genuinely returns
 * `ok:false`, and the host then refuses to route to the peer (Axis 1). On Linux-with-bubblewrap it
 * returns `ok:true` (VERIFIED-ON-LINUX). The truth of the hardware, advertised as-is.
 */
export function peerSelfTest(): Promise<SelfTestResult> {
  return detectSandbox().then(verifiedSelfTest);
}

export async function buildPeerHello(
  peerId: string,
  cliProviders: PeerHello['cliProviders'],
): Promise<PeerHello> {
  return { peerId, cliProviders, sandbox: await peerSelfTest() };
}

const refused = (why: string): PeerResult => ({
  ok: false,
  output: `peer refused: ${why}`,
  patch: {},
  changedFiles: [],
});

export type AdapterRunner = (req: PeerInvokeRequest, cwd: string) => Promise<PeerResult>;

/**
 * Run ONE invoke on the peer. The peer RE-DERIVES its own binding from the (advisory) host policy and
 * REFUSES if its jail isn't verified — an EXPLICIT `binding.verified` gate BEFORE the adapter, because
 * `--mock` writes files directly and does NOT route through `spawnSandboxed` (so the spawn wrapper can't
 * be the backstop here). Defense in depth: the host already refuses an unverified peer at JOIN; this
 * refuses again at INVOKE. The adapter is never reached when the peer is unverified.
 */
export async function runPeerInvoke(
  req: PeerInvokeRequest,
  cwd: string,
  opts: { runAdapter?: AdapterRunner } = {},
): Promise<PeerResult> {
  const binding = await resolveSandboxBinding(req.policy, cwd, { required: true });
  if (!binding.verified) return refused('no verified sandbox on this peer');
  return (opts.runAdapter ?? defaultRunAdapter)(req, cwd);
}

/** The real run path: execute the (mock) adapter into the peer's scratch worktree, then read the changed
 *  files back into a patch. Patch-only: the host derives `changedFiles` itself from its own git. */
async function defaultRunAdapter(req: PeerInvokeRequest, cwd: string): Promise<PeerResult> {
  const adapter = adapterFor(req.providerId, 'mock'); // --mock: deterministic, zero tokens
  let ok = false;
  let output = '';
  let changed: string[] = [];
  let usage: PeerResult['usage'];
  for await (const event of adapter.invoke({
    prompt: req.prompt,
    cwd,
    policy: req.policy,
    mode: 'mock',
  })) {
    if (event.type === 'result') {
      ok = event.result.ok;
      output = event.result.output;
      changed = event.result.changedFiles ?? [];
      usage = event.result.usage;
    }
  }
  const patch: Record<string, string> = {};
  for (const rel of changed) {
    try {
      patch[rel] = fs.readFileSync(path.join(cwd, rel), 'utf8');
    } catch {
      /* deleted — host git still sees the deletion */
    }
  }
  return { ok, output, patch, changedFiles: changed, usage };
}

export type JoinOutcome = 'pending' | 'admitted' | 'rejected';

export interface PeerAgentHandle {
  readonly hello: PeerHello;
  /** Next frame the host sent (buffered) — lets a test observe join.pending/admitted/rejected. */
  next(): Promise<CollabFrame>;
  close(): void;
}

/**
 * Dial the host's collab endpoint, send the join handshake, and serve invokes. Returns once the socket
 * is open and the join frame has been sent. Invoke frames are auto-served via `runPeerInvoke` (so a
 * never-verified peer that somehow receives one still refuses on its own side).
 */
export function connectPeer(opts: {
  url: string;
  peerId: string;
  token: string;
  hello: PeerHello;
  cwd: string;
  runAdapter?: AdapterRunner;
}): Promise<PeerAgentHandle> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(opts.url);
    const q: CollabFrame[] = [];
    const waiters: Array<(f: CollabFrame) => void> = [];
    const push = (f: CollabFrame) => {
      const w = waiters.shift();
      if (w) w(f);
      else q.push(f);
    };

    ws.on('message', (raw: Buffer) => {
      const frame = parseFrame(raw.toString());
      if (!frame) return;
      push(frame);
      if (frame.t === 'invoke') {
        void runPeerInvoke(frame.req, opts.cwd, { runAdapter: opts.runAdapter }).then((result) => {
          if (ws.readyState === ws.OPEN)
            ws.send(JSON.stringify({ t: 'result', id: frame.id, result }));
        });
      }
    });
    ws.once('error', reject);
    ws.once('open', () => {
      ws.send(
        JSON.stringify({ t: 'join', peerId: opts.peerId, token: opts.token, hello: opts.hello }),
      );
      resolve({
        hello: opts.hello,
        next: () =>
          q.length
            ? Promise.resolve(q.shift()!)
            : new Promise<CollabFrame>((res) => waiters.push(res)),
        close: () => ws.close(),
      });
    });
  });
}
