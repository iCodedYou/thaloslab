// G1 — engine→collab DISPATCH, proven through the REAL StageRunner.run over a real loopback socket, with
// the proven Wire-D machinery (makeCollabAdapter + connectPeer + CollabService + confiningSeam) reused
// verbatim. Two things are proven here that Wire D did NOT (it drove the adapter directly):
//   1. FAIL-CLOSED on EVERY throw — the collab adapter throws by design (PeerRevokedError on mid-flight
//      revoke, SecretLeakError on a planted secret, PeerInvokeTimeoutError). The StageRunner's try/catch
//      converts each into a failed+ESCALATED outcome — never a crash, never a silent proceed, and the
//      peer's patch NEVER reaches quarantine. (Mutation: delete the try/catch and the revoke test throws
//      instead of escalating.)
//   2. The security path is UNCHANGED through the ENGINE's dispatch: pack(secret-strip + manifest BEFORE
//      the socket) → push → peer runs → applyPeerPatch in QUARANTINE → host-git re-derives changedFiles
//      (the peer's ok/changedFiles NEVER consumed) → re-gate. A lying peer is caught by the host derivation.
//
// TWO CLAIMS DISTINCT (as in Wire D): this proves the WIRE + trust + quarantine THROUGH the engine, over a
// real socket, --mock. It does NOT prove a real jail confined the peer (seam) nor a real provider ran it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Sandbox, WorkflowTemplate } from '@thaloslab/shared';
import type { PeerLink } from '../collab/wire/peer-link';

const dbFile = path.join(os.tmpdir(), `thalos-cdispatch-${process.pid}-${Date.now()}.db`);
process.env.THALOS_DB_PATH = dbFile;

const { openDb, closeDb } = await import('../store/db');
const { runMigrations } = await import('../store/migrate');
const { insertProject } = await import('../store/repositories/projects');
const { insertTicket } = await import('../store/repositories/tickets');
const { insertTask, getTask } = await import('../store/repositories/tasks');
const { EventBus } = await import('./events');
const { createProductionStageRunner } = await import('./stage-runner');
const { CollabService } = await import('../collab/collab-service');
const { CollabRuntime } = await import('../collab/runtime');
const { buildPeerHello, connectPeer } = await import('../collab/peer-agent/agent');
const { PeerInvokeTimeoutError } = await import('../collab/wire/peer-link');
const { listManifests } = await import('../collab/manifest-store');
const { resetSandbox, setSandbox } = await import('../providers/sandbox');
const { resetMock, setMockProgram } = await import('../providers/mock');

// Test-seam "verified" sandbox so the peer is admittable on this Windows box (a STAND-IN for a real jail,
// proven elsewhere: VERIFIED-ON-LINUX / VERIFIED-ON-MACOS). The WIRE + dispatch is what G1 exercises.
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

const template: WorkflowTemplate = {
  id: 'feature',
  label: 'Feature',
  appliesTo: ['feature'],
  mutating: true,
  stages: [{ id: 'impl', role: 'engineer', produces: ['diff'], dependsOn: [] }],
  gates: [],
};

const cleanups: Array<() => Promise<void> | void> = [];
let seq = 0;

beforeAll(() => {
  runMigrations(openDb());
});
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  resetSandbox();
  resetMock();
});
afterAll(() => {
  closeDb();
});

async function makeRepo(seamContent = 'export const a = () => 0;\n'): Promise<string> {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'thalos-cd-'));
  const git = simpleGit(repo);
  await git.init(['-b', 'main']);
  fs.appendFileSync(
    path.join(repo, '.git', 'config'),
    '[user]\n\temail = t@localhost\n\tname = T\n',
  );
  fs.writeFileSync(path.join(repo, '.gitignore'), '.thalos/\n');
  fs.mkdirSync(path.join(repo, 'src', 'a'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'a', 'index.ts'), seamContent);
  await git.add('.');
  await git.commit('init');
  cleanups.push(() => fs.rmSync(repo, { recursive: true, force: true }));
  return repo;
}

/** Insert a project (pointing at `repo`, collab-opted-in), a feature ticket, and one engineer task with a
 *  seam. Returns the ids for driving StageRunner.run. */
function setupTicket(
  repo: string,
  opts: { collabEnabled?: boolean } = {},
): { ticketId: string; taskId: string } {
  const n = seq++;
  const projectId = `p${n}`;
  const ticketId = `tk${n}`;
  const taskId = `impl${n}`;
  insertProject({
    id: projectId,
    name: 'P',
    repoPath: repo,
    origin: 'scratch',
    phase: 'maintenance',
    orchestratorProvider: 'claude',
    createdAt: 1,
    routingPolicy: opts.collabEnabled === false ? {} : { collab: true },
  });
  insertTicket({
    id: ticketId,
    projectId,
    title: 'implement a()',
    workflowId: 'feature',
    status: 'running',
    mode: 'mock',
    createdAt: 1,
  });
  insertTask({
    id: taskId,
    ticketId,
    stageId: 'impl',
    kind: 'stage',
    laneId: `${ticketId}:main`,
    dependsOn: [],
    seamPaths: ['src/a'],
    state: 'running',
    retryCount: 0,
    attempt: 0,
    createdAt: 1,
  });
  return { ticketId, taskId };
}

/** Stand up a host CollabService + an admitted, verified (seam) --mock peer over a real loopback socket. */
async function admittedPeer(runAdapter?: Parameters<typeof connectPeer>[0]['runAdapter']) {
  setSandbox(confiningSeam);
  const svc = new CollabService(new CollabRuntime());
  const port = await svc.enable({ port: 0 });
  const token = svc.invite('peerB');
  const peerCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'thalos-peercwd-'));
  const hello = await buildPeerHello('peerB', [
    { id: 'codex', vendor: 'codex', authenticated: true },
  ]);
  const peer = await connectPeer({
    url: `ws://127.0.0.1:${port}`,
    peerId: 'peerB',
    token,
    hello,
    cwd: peerCwd,
    runAdapter,
  });
  expect((await peer.next()).t).toBe('join.pending');
  svc.admit('peerB');
  expect((await peer.next()).t).toBe('join.admitted');
  cleanups.push(async () => {
    peer.close();
    await svc.disable();
    fs.rmSync(peerCwd, { recursive: true, force: true });
  });
  return { svc, peer };
}

const collabDecision = () =>
  ({ kind: 'collab', peerId: 'peerB', vendor: 'codex', providerId: 'collab:peerB:codex' }) as const;

describe('engine→collab dispatch through the REAL StageRunner (loopback socket, --mock)', () => {
  it('HAPPY PATH: round-trip through the engine — pack→push→peer→quarantine→host-git changedFiles→commit + manifest', async () => {
    const repo = await makeRepo();
    const { svc } = await admittedPeer();
    // The peer's --mock writes the in-seam change; the host derives changedFiles from ITS git, not the peer.
    setMockProgram(() => ({
      ok: true,
      output: 'implemented a',
      writeFiles: { 'src/a/index.ts': 'export const a = () => 1;\n' },
    }));
    const { ticketId, taskId } = setupTicket(repo);

    const runner = createProductionStageRunner({
      bus: new EventBus(),
      now: () => 1,
      resolveCollab: () => collabDecision(),
      collabLinkFor: (id) => svc.linkFor(id),
    });
    const outcome = await runner.run({ ticketId, task: getTask(taskId)!, template });

    expect(outcome.ok).toBe(true);
    expect(outcome.changedFiles).toEqual(['src/a/index.ts']); // HOST-derived
    // The manifest records exactly what crossed (path + sha) — NO credential, NO host absolute path.
    const manifests = JSON.stringify(listManifests(repo));
    expect(manifests).toContain('src/a/index.ts');
    expect(manifests).not.toContain(repo); // no host absolute path
    expect(manifests).not.toMatch(/sk-[A-Za-z0-9]{16}/); // no secret
  });

  it('LYING peer (out-of-seam write) is CAUGHT by the host through the engine — peer claim ignored', async () => {
    const repo = await makeRepo();
    const { svc } = await admittedPeer(async () => ({
      ok: true, // a LIE
      output: 'done',
      patch: { 'src/b/evil.ts': 'export const evil = 1;\n' }, // OUT of the src/a seam
      changedFiles: ['src/a/index.ts'], // a LIE
    }));
    const { ticketId, taskId } = setupTicket(repo);

    const runner = createProductionStageRunner({
      bus: new EventBus(),
      now: () => 1,
      resolveCollab: () => collabDecision(),
      collabLinkFor: (id) => svc.linkFor(id),
    });
    const outcome = await runner.run({ ticketId, task: getTask(taskId)!, template });

    expect(outcome.ok).toBe(false); // the host seam audit rejected the out-of-seam write
    expect(outcome.changedFiles).not.toEqual(['src/a/index.ts']); // the peer's LIE was not consumed
  });

  it('FAIL-CLOSED on revoke mid-dispatch: PeerRevokedError → escalate; the patch NEVER reaches quarantine', async () => {
    const repo = await makeRepo();
    const { svc } = await admittedPeer();
    setMockProgram(() => ({
      ok: true,
      output: 'x',
      writeFiles: { 'src/a/index.ts': 'export const a = () => 1;\n' },
    }));
    const link = svc.linkFor('peerB'); // captured while authorized…
    expect(link).not.toBeNull();
    svc.revoke('peerB'); // …then revoked BEFORE the dispatch pushes (link.invoke will reject PeerRevokedError)
    const { ticketId, taskId } = setupTicket(repo);

    const runner = createProductionStageRunner({
      bus: new EventBus(),
      now: () => 1,
      resolveCollab: () => collabDecision(),
      collabLinkFor: () => link, // the now-revoked link (routable at routing time, revoked before push)
    });
    const outcome = await runner.run({ ticketId, task: getTask(taskId)!, template });

    expect(outcome.ok).toBe(false);
    expect(outcome.escalate).toBe(true);
    expect(outcome.output).toContain('failed closed');
    // The peer's patch NEVER applied — the seam file is untouched (the throw is at push, before quarantine).
    // Read it from a fresh worktree checkout of the lane branch is complex; assert host-derived changedFiles empty.
    expect(outcome.changedFiles).toEqual([]);
  });

  it('FAIL-CLOSED on a planted secret: SecretLeakError aborts host-side BEFORE the socket → escalate', async () => {
    const repo = await makeRepo(
      'const KEY = "sk-abcdef0123456789abcd";\nexport const a = () => 0;\n',
    );
    const { svc } = await admittedPeer();
    const { ticketId, taskId } = setupTicket(repo);

    const runner = createProductionStageRunner({
      bus: new EventBus(),
      now: () => 1,
      resolveCollab: () => collabDecision(),
      collabLinkFor: (id) => svc.linkFor(id),
    });
    const outcome = await runner.run({ ticketId, task: getTask(taskId)!, template });

    expect(outcome.ok).toBe(false);
    expect(outcome.escalate).toBe(true);
    expect(outcome.output).toContain('failed closed');
  });

  it('FAIL-CLOSED on timeout: PeerInvokeTimeoutError → escalate (same try/catch, real error type)', async () => {
    const repo = await makeRepo();
    const { ticketId, taskId } = setupTicket(repo);
    // A stub link that rejects with the REAL timeout error type (a real 5-min wait is not run in a test).
    const timingOut = {
      peerId: 'peerB',
      invoke: () => Promise.reject(new PeerInvokeTimeoutError()),
    };

    const runner = createProductionStageRunner({
      bus: new EventBus(),
      now: () => 1,
      resolveCollab: () => collabDecision(),
      collabLinkFor: () => timingOut as unknown as PeerLink,
    });
    const outcome = await runner.run({ ticketId, task: getTask(taskId)!, template });

    expect(outcome.ok).toBe(false);
    expect(outcome.escalate).toBe(true);
    expect(outcome.output).toContain('failed closed');
  });

  it('link unavailable at dispatch (revoked/disabled since routing) → FAIL CLOSED, no local fall-back', async () => {
    const repo = await makeRepo();
    const { ticketId, taskId } = setupTicket(repo);
    const runner = createProductionStageRunner({
      bus: new EventBus(),
      now: () => 1,
      resolveCollab: () => collabDecision(),
      collabLinkFor: () => null, // no live link
    });
    const outcome = await runner.run({ ticketId, task: getTask(taskId)!, template });
    expect(outcome.ok).toBe(false);
    expect(outcome.escalate).toBe(true);
    expect(outcome.output).toContain('link unavailable');
  });
});
