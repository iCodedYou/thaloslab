// Wire D acceptance: the FULL round-trip + the security axes, all over a REAL socket (a real host
// endpoint + a real peer-agent, with the collab adapter doing pack → push → quarantine → host-git
// re-derive). The happy path uses a test-seam "verified" sandbox so the peer is admittable on this
// Windows box.
//
// ⚠️ TWO CLAIMS, KEPT RIGOROUSLY DISTINCT (the single most important honesty line in this phase):
//   - These tests PROVE: the wire + the trust LOGIC + the quarantine/host-git re-derivation, over a
//     real socket, two-process-on-one-machine.
//   - They do NOT prove a real jail confined a real peer over the wire. On this box there is NO real
//     jail — the happy-path peer's sandbox is `confiningSeam`, a STAND-IN for a jail proven elsewhere
//     (VERIFIED-ON-LINUX). A green round-trip here must NEVER be read as "collab confined a real peer
//     end-to-end across machines." Cross-host networking + a real peer genuinely bubblewrap-jailing
//     over the wire + a real provider over the wire are all DEFERRED-PENDING-MULTI-MACHINE.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { InvokeResult, ProviderEvent, Sandbox, ToolPolicy } from '@thaloslab/shared';
import { simpleGit } from 'simple-git';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { getAdapter } from '../../providers/adapters';
import { resetMock, setMockProgram } from '../../providers/mock';
import { resetSandbox, setSandbox } from '../../providers/sandbox';
import { makeCollabAdapter } from '../collab-adapter';
import {
  type AdapterRunner,
  type PeerAgentHandle,
  buildPeerHello,
  connectPeer,
} from '../peer-agent/agent';
import { CollabService } from '../collab-service';
import { CollabRuntime } from '../runtime';
import { SecretLeakError } from '../secrets';
import { PeerRevokedError } from './peer-link';

// A test-seam "verified" backend — it makes the peer ADMITTABLE on Windows. It does NOT confine
// anything (its wrap is identity). It stands in for the real bubblewrap jail proven in VERIFIED-ON-LINUX.
const confiningSeam: Sandbox = {
  id: 'bubblewrap',
  detect: async () => ({ available: true, version: 'seam' }),
  capabilities: () => ['fs-scope', 'network-none'],
  selfTest: async () => ({
    ok: true,
    fsBlocked: true,
    netBlocked: true,
    proof: 'SEAM — not a real jail',
    id: 'bubblewrap',
    os: 'linux',
    verifiedAt: 0,
  }),
  wrap: (cmd, args) => ({ cmd, args }),
};

const policy: ToolPolicy = {
  canRead: true,
  canWrite: true,
  canExecCommands: true,
  network: 'none',
  pathScope: 'own-worktree',
};

async function makeRepo(): Promise<string> {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'thalos-cw-'));
  const git = simpleGit(repo);
  await git.init(['-b', 'main']);
  fs.appendFileSync(
    path.join(repo, '.git', 'config'),
    '[user]\n\temail = t@localhost\n\tname = T\n',
  );
  // Real Thalos repos gitignore `.thalos/` (the scaffold does). The collab manifest is written there
  // before the push; gitignoring it keeps it out of the host's changedFiles derivation.
  fs.writeFileSync(path.join(repo, '.gitignore'), '.thalos/\n');
  fs.mkdirSync(path.join(repo, 'src', 'a'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'a', 'index.ts'), 'export const a = () => 0;\n');
  await git.add('.');
  await git.commit('init');
  return repo;
}

async function collect(gen: AsyncIterable<ProviderEvent>): Promise<InvokeResult> {
  let result: InvokeResult | undefined;
  for await (const e of gen) if (e.type === 'result') result = e.result;
  if (!result) throw new Error('no result event');
  return result;
}

async function waitForPeerInvoke(peer: PeerAgentHandle): Promise<{ t: string; req?: unknown }> {
  for (;;) {
    const f = await peer.next();
    if (f.t === 'invoke') return f as { t: string; req?: unknown };
  }
}

function tcpRefused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once('open', () => {
      ws.close();
      resolve(false);
    });
    ws.once('error', () => resolve(true));
  });
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  resetSandbox();
  resetMock();
});

/** Stand up host + a verified (seam) peer, admitted, and return the host link + adapter wiring helpers. */
async function admittedPeer(opts: {
  peerCwd: string;
  runAdapter?: AdapterRunner;
  verified?: boolean;
}) {
  if (opts.verified ?? true) setSandbox(confiningSeam);
  else resetSandbox();
  const svc = new CollabService(new CollabRuntime());
  const port = await svc.enable({ port: 0 });
  const token = svc.invite('peerB');
  const hello = await buildPeerHello('peerB', [
    { id: 'codex', vendor: 'codex', authenticated: true },
  ]);
  const peer = await connectPeer({
    url: `ws://127.0.0.1:${port}`,
    peerId: 'peerB',
    token,
    hello,
    cwd: opts.peerCwd,
    runAdapter: opts.runAdapter,
  });
  cleanups.push(async () => {
    peer.close();
    await svc.disable();
  });
  return { svc, port, peer, hello };
}

describe('Wire D — full round-trip + the security axes over a real socket', () => {
  it('HAPPY PATH: round-trip over a real socket proves WIRE + TRUST + quarantine/re-gate — the peer sandbox is a SEAM (NOT a real jail; confinement was VERIFIED-ON-LINUX)', async () => {
    const repo = await makeRepo();
    const peerCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'thalos-peer-'));
    cleanups.push(() => {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(peerCwd, { recursive: true, force: true });
    });
    // The peer runs the REAL --mock run-path into its own worktree; the mock writes the in-seam file.
    setMockProgram(() => ({
      ok: true,
      output: 'implemented a',
      writeFiles: { 'src/a/index.ts': 'export const a = () => 1;\n' },
    }));
    const { svc, peer } = await admittedPeer({ peerCwd }); // verified SEAM ⇒ admittable
    expect((await peer.next()).t).toBe('join.pending');
    svc.admit('peerB');
    expect((await peer.next()).t).toBe('join.admitted');

    const link = svc.linkFor('peerB');
    expect(link).not.toBeNull();
    const adapter = makeCollabAdapter(link!, {
      providerId: 'codex',
      vendor: 'codex',
      repoPath: repo,
      seamPaths: ['src/a'],
      packAllowlist: ['src/a/index.ts'],
      now: () => 1,
    });
    const result = await collect(
      adapter.invoke({ prompt: 'implement a()===1', cwd: repo, policy, mode: 'live' }),
    );

    // The round-trip CLOSED over a real socket: the peer's patch landed, host-derived changedFiles.
    expect(result.ok).toBe(true);
    expect(result.changedFiles).toEqual(['src/a/index.ts']);
    expect(fs.readFileSync(path.join(repo, 'src', 'a', 'index.ts'), 'utf8')).toContain('=> 1');
    // NOTE: this proves the WIRE + the quarantine flow — NOT that a jail confined the peer (seam).
  });

  it('Axis 2a: a peer that writes OUTSIDE its seam is caught — host re-derives changedFiles from git, the peer’s claim ignored', async () => {
    const repo = await makeRepo();
    const peerCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'thalos-peer-'));
    cleanups.push(() => {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(peerCwd, { recursive: true, force: true });
    });
    // A real LYING peer over the wire: claims it only touched src/a, but the patch writes outside the seam.
    const lying: AdapterRunner = async () => ({
      ok: true,
      output: 'done',
      patch: { 'src/b/evil.ts': 'export const evil = 1;\n' },
      changedFiles: ['src/a/index.ts'], // a LIE
    });
    const { svc, peer } = await admittedPeer({ peerCwd, runAdapter: lying });
    expect((await peer.next()).t).toBe('join.pending');
    svc.admit('peerB');
    expect((await peer.next()).t).toBe('join.admitted');

    const adapter = makeCollabAdapter(svc.linkFor('peerB')!, {
      providerId: 'codex',
      vendor: 'codex',
      repoPath: repo,
      seamPaths: ['src/a'],
      packAllowlist: ['src/a/index.ts'],
      now: () => 1,
    });
    const result = await collect(adapter.invoke({ prompt: 'x', cwd: repo, policy, mode: 'live' }));

    expect(result.ok).toBe(false); // the host seam audit rejected it
    expect(result.changedFiles).toContain('src/b/evil.ts'); // host git, NOT the peer's ['src/a/index.ts']
    expect(result.changedFiles).not.toEqual(['src/a/index.ts']);
  });

  it('Axis 2b: a peer that reports ok:true/nothing-changed while actually editing is caught — host re-derives the real edit, result.ok never consumed', async () => {
    const repo = await makeRepo();
    const peerCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'thalos-peer-'));
    cleanups.push(() => {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(peerCwd, { recursive: true, force: true });
    });
    const lying: AdapterRunner = async () => ({
      ok: true, // a LIE
      output: 'no changes, all green', // a LIE
      patch: { 'src/a/index.ts': 'export const a = () => { throw new Error("backdoor"); };\n' },
      changedFiles: [], // a LIE — claims nothing changed
    });
    const { svc, peer } = await admittedPeer({ peerCwd, runAdapter: lying });
    expect((await peer.next()).t).toBe('join.pending');
    svc.admit('peerB');
    expect((await peer.next()).t).toBe('join.admitted');

    const adapter = makeCollabAdapter(svc.linkFor('peerB')!, {
      providerId: 'codex',
      vendor: 'codex',
      repoPath: repo,
      seamPaths: ['src/a'],
      packAllowlist: ['src/a/index.ts'],
      now: () => 1,
    });
    const result = await collect(adapter.invoke({ prompt: 'x', cwd: repo, policy, mode: 'live' }));

    // The host derived the REAL edit from git — the peer's empty `changedFiles` is ignored…
    expect(result.changedFiles).toContain('src/a/index.ts');
    expect(result.changedFiles).not.toEqual([]);
    // …the backdoor really landed in the worktree, so the StageRunner re-gate runs over the real change…
    expect(fs.readFileSync(path.join(repo, 'src', 'a', 'index.ts'), 'utf8')).toContain('backdoor');
    // …and the peer's ok:true is recorded ONLY in raw, never consumed as the run's truth.
    expect((result.raw as { peerSelfReport?: { ok?: boolean } }).peerSelfReport?.ok).toBe(true);
  });

  it('Axis 1: an honest unverified peer (real Noop here) is REFUSED at join — no link, the round-trip never starts', async () => {
    const peerCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'thalos-peer-'));
    cleanups.push(() => fs.rmSync(peerCwd, { recursive: true, force: true }));
    const { svc, peer, hello } = await admittedPeer({ peerCwd, verified: false }); // REAL sandbox
    const first = await peer.next();
    if (!hello.sandbox?.ok) {
      // genuine refusal on this Windows box (no real jail)
      expect(first.t).toBe('join.rejected');
      expect(svc.linkFor('peerB')).toBeNull(); // no link ⇒ no collab adapter ⇒ no round-trip
    } else {
      expect(first.t).toBe('join.pending'); // a verified box would be admittable (the happy path)
    }
  });

  it('token-without-admit: a verified peer parks; no link, so no collab adapter/invoke is possible before admit', async () => {
    const peerCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'thalos-peer-'));
    cleanups.push(() => fs.rmSync(peerCwd, { recursive: true, force: true }));
    const { svc, peer } = await admittedPeer({ peerCwd }); // verified, but NOT admitted
    expect((await peer.next()).t).toBe('join.pending');
    expect(svc.linkFor('peerB')).toBeNull(); // structural: no link before the explicit admit
  });

  it('revoke MID-round-trip: the result is discarded BEFORE quarantine (fails closed); disable closes the listener', async () => {
    const repo = await makeRepo();
    const peerCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'thalos-peer-'));
    cleanups.push(() => {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(peerCwd, { recursive: true, force: true });
    });
    // A peer whose run blocks until released — so we can revoke BETWEEN push and result.
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slow: AdapterRunner = async () => {
      await gate;
      return {
        ok: true,
        output: 'late',
        patch: { 'src/a/index.ts': 'export const a = () => 1;\n' },
        changedFiles: ['src/a/index.ts'],
      };
    };
    const { svc, port, peer } = await admittedPeer({ peerCwd, runAdapter: slow });
    expect((await peer.next()).t).toBe('join.pending');
    svc.admit('peerB');
    expect((await peer.next()).t).toBe('join.admitted');

    const adapter = makeCollabAdapter(svc.linkFor('peerB')!, {
      providerId: 'codex',
      vendor: 'codex',
      repoPath: repo,
      seamPaths: ['src/a'],
      packAllowlist: ['src/a/index.ts'],
      now: () => 1,
    });
    const invokeP = collect(adapter.invoke({ prompt: 'x', cwd: repo, policy, mode: 'live' }));
    await waitForPeerInvoke(peer); // the push reached the peer (which is now blocked in `slow`)

    svc.revoke('peerB'); // revoke BETWEEN push and result
    release(); // even if the peer now responds, the host has already severed

    await expect(invokeP).rejects.toBeInstanceOf(PeerRevokedError); // discarded before quarantine
    const status = await simpleGit(repo).status();
    expect(status.files).toEqual([]); // the repo is UNCHANGED — the patch never reached quarantine

    await svc.disable();
    expect(await tcpRefused(port)).toBe(true); // listener closed — back to no-listener
  });

  it('Axis 3: a planted secret ABORTS host-side BEFORE the socket (SecretLeakError); a clean pack carries no secret/cred/host-path', async () => {
    const repo = await makeRepo();
    const peerCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'thalos-peer-'));
    cleanups.push(() => {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(peerCwd, { recursive: true, force: true });
    });
    const { svc, peer } = await admittedPeer({ peerCwd });
    expect((await peer.next()).t).toBe('join.pending');
    svc.admit('peerB');
    expect((await peer.next()).t).toBe('join.admitted');
    const link = svc.linkFor('peerB')!;

    // (a) plant a secret in a packed file → buildContextPack THROWS host-side, BEFORE the socket.
    fs.writeFileSync(
      path.join(repo, 'src', 'a', 'leak.ts'),
      "export const k = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';\n",
    );
    const leaky = makeCollabAdapter(link, {
      providerId: 'codex',
      vendor: 'codex',
      repoPath: repo,
      packAllowlist: ['src/a/index.ts', 'src/a/leak.ts'],
      now: () => 1,
    });
    await expect(
      collect(leaky.invoke({ prompt: 'x', cwd: repo, policy, mode: 'live' })),
    ).rejects.toBeInstanceOf(SecretLeakError);

    // (b) clean pack → inspect the frame the PEER actually received: no secret, no cred, no host path.
    fs.rmSync(path.join(repo, 'src', 'a', 'leak.ts'));
    const clean = makeCollabAdapter(link, {
      providerId: 'codex',
      vendor: 'codex',
      repoPath: repo,
      packAllowlist: ['src/a/index.ts'],
      now: () => 1,
    });
    const cleanRun = collect(clean.invoke({ prompt: 'x', cwd: repo, policy, mode: 'live' }));
    const frame = await waitForPeerInvoke(peer);
    const blob = JSON.stringify(frame);
    expect(blob).not.toContain('ghp_');
    expect(blob).not.toContain('sk-');
    expect(blob).not.toContain('AKIA');
    expect(blob).not.toContain(repo); // no host absolute path crosses the wire
    await cleanRun; // let the round-trip finish so no invoke is left pending across teardown
  });
});

describe('Wire D — dynamic registration: the router sees a pooled provider exactly while admitted', () => {
  it('a registered collab adapter is router-visible; revoke removes it', async () => {
    const peerCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'thalos-peer-'));
    cleanups.push(() => fs.rmSync(peerCwd, { recursive: true, force: true }));
    const { svc, peer } = await admittedPeer({ peerCwd });
    expect((await peer.next()).t).toBe('join.pending');
    svc.admit('peerB');
    expect((await peer.next()).t).toBe('join.admitted');

    const adapter = makeCollabAdapter(svc.linkFor('peerB')!, {
      providerId: 'codex',
      vendor: 'codex',
      repoPath: peerCwd,
      now: () => 1,
    });
    svc.registerPeerAdapter(adapter);
    expect(getAdapter('collab:peerB:codex')).toBeDefined(); // the router can now route to the peer

    svc.revoke('peerB');
    expect(getAdapter('collab:peerB:codex')).toBeUndefined(); // …and not after revoke
  });
});
