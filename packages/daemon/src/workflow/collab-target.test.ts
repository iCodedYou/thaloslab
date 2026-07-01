// H1 — assembler-aware collab born-targeting, proven end to end. The MONEY test: project config (the real
// setter) → intake ASSEMBLY borns the engineer agent with provider=collab:peerB:codex → a task using that
// agent dispatches through the REAL StageRunner (default deps → the singleton collabService + a real
// loopback --mock peer) → the round-trip lands (host-derived changedFiles + manifest). No injection, no
// mid-flight retarget — the agent is BORN targeting the peer at assembly (intake.ts), which is the non-racy
// fix for what stopped G2. Plus: fan-out safety, fail-closed-not-routable (mutation-proven), default-off,
// reviewer-differs. TWO CLAIMS DISTINCT: this proves config→born→DISPATCH under --mock over a real socket;
// it does NOT confine the task in a real jail (seam) nor run a real provider.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Sandbox, ToolPolicy, WorkflowTemplate } from '@thaloslab/shared';

const dbFile = path.join(os.tmpdir(), `thalos-ctarget-${process.pid}-${Date.now()}.db`);
process.env.THALOS_DB_PATH = dbFile;

const { openDb } = await import('../store/db');
const { runMigrations } = await import('../store/migrate');
const { insertProject, setProjectRoutingPolicy } = await import('../store/repositories/projects');
const { getAgent } = await import('../store/repositories/agents');
const { insertTicket } = await import('../store/repositories/tickets');
const { insertTask, getTask } = await import('../store/repositories/tasks');
const { intakeTicket } = await import('./orchestrator/intake');
const { createRuntime } = await import('./runtime');
const { createProductionStageRunner } = await import('./stage-runner');
const { EventBus } = await import('./events');
const { collabService } = await import('../collab/collab-service');
const { buildPeerHello, connectPeer } = await import('../collab/peer-agent/agent');
const { listManifests } = await import('../collab/manifest-store');
const { resetSandbox, setSandbox } = await import('../providers/sandbox');
const { resetMock, setMockProgram } = await import('../providers/mock');
const { resolveForInvoke } = await import('../providers/router');

const confiningSeam: Sandbox = {
  id: 'bubblewrap',
  detect: async () => ({ available: true, version: 'seam' }),
  capabilities: () => ['fs-scope', 'network-none'],
  selfTest: async () => ({
    ok: true,
    fsBlocked: true,
    netBlocked: true,
    proof: 'SEAM',
    id: 'bubblewrap',
    os: 'linux',
    verifiedAt: 0,
  }),
  wrap: (cmd, args) => ({ cmd, args }),
};

const implTemplate: WorkflowTemplate = {
  id: 'feature',
  label: 'F',
  appliesTo: ['feature'],
  mutating: true,
  stages: [{ id: 'impl', role: 'engineer', produces: ['diff'], dependsOn: [] }],
  gates: [],
};

const runtime = createRuntime();
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

async function makeRepo(): Promise<string> {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'thalos-ct-'));
  const git = simpleGit(repo);
  await git.init(['-b', 'main']);
  fs.appendFileSync(
    path.join(repo, '.git', 'config'),
    '[user]\n\temail = t@localhost\n\tname = T\n',
  );
  fs.writeFileSync(path.join(repo, '.gitignore'), '.thalos/\n');
  fs.mkdirSync(path.join(repo, 'src', 'a'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'a', 'index.ts'), 'export const a = () => 0;\n');
  await git.add('.');
  await git.commit('init');
  cleanups.push(() => fs.rmSync(repo, { recursive: true, force: true }));
  return repo;
}

/** Insert a collab-opted-in project (via the real setter) pointing at a fresh repo; return ids. */
async function collabProject(target?: string): Promise<{ projectId: string; repo: string }> {
  const projectId = `p${seq++}`;
  const repo = await makeRepo();
  insertProject({
    id: projectId,
    name: projectId,
    repoPath: repo,
    origin: 'scratch',
    phase: 'maintenance',
    orchestratorProvider: 'claude',
    createdAt: 1,
  });
  setProjectRoutingPolicy(
    projectId,
    target === undefined
      ? { collab: false }
      : { collab: true, collabTargets: { engineer: target } },
  );
  return { projectId, repo };
}

/** Stand up a verified --mock peer on the SINGLETON collabService (the real production path the default
 *  resolveCollab/collabLinkFor read) over a real loopback socket, admitted. */
async function admitSingletonPeer(): Promise<void> {
  setSandbox(confiningSeam);
  const port = await collabService.enable({ port: 0 });
  const token = collabService.invite('peerB');
  const peerCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'thalos-ctpeer-'));
  const hello = await buildPeerHello('peerB', [
    { id: 'codex', vendor: 'codex', authenticated: true },
  ]);
  const peer = await connectPeer({
    url: `ws://127.0.0.1:${port}`,
    peerId: 'peerB',
    token,
    hello,
    cwd: peerCwd,
  });
  expect((await peer.next()).t).toBe('join.pending');
  collabService.admit('peerB');
  expect((await peer.next()).t).toBe('join.admitted');
  cleanups.push(async () => {
    peer.close();
    await collabService.disable();
    fs.rmSync(peerCwd, { recursive: true, force: true });
  });
}

/** Insert a mock-mode ticket + one engineer 'impl' task bound to the project's born engineer agent. */
function implTask(projectId: string): { ticketId: string; taskId: string } {
  const ticketId = `dtk${seq++}`;
  const taskId = `dimpl${seq++}`;
  insertTicket({
    id: ticketId,
    projectId,
    title: 't',
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
    agentId: `ag-${projectId}-engineer`,
    state: 'running',
    retryCount: 0,
    attempt: 0,
    createdAt: 1,
  });
  return { ticketId, taskId };
}

describe('collab born-targeting — config → assembly → dispatch (end to end)', () => {
  it('THE MONEY TEST: config → intake BORNS engineer collab:peerB:codex → dispatch round-trips through the REAL StageRunner', async () => {
    const { projectId, repo } = await collabProject('collab:peerB:codex');
    await admitSingletonPeer();

    // Config → intake ASSEMBLY borns the engineer agent (preview: assemble only, no advance).
    await intakeTicket(runtime.engine, {
      projectId,
      title: 'fix the sum bug',
      body: 'x',
      mode: 'preview',
    });
    expect(getAgent(`ag-${projectId}-engineer`)?.provider).toBe('collab:peerB:codex'); // BORN at assembly

    // A task using that born agent dispatches through the REAL StageRunner (default deps → singleton peer).
    setMockProgram(() => ({
      ok: true,
      output: 'impl',
      writeFiles: { 'src/a/index.ts': 'export const a = () => 1;\n' },
    }));
    const { ticketId, taskId } = implTask(projectId);
    const runner = createProductionStageRunner({ bus: new EventBus(), now: () => 1 });
    const outcome = await runner.run({ ticketId, task: getTask(taskId)!, template: implTemplate });

    expect(outcome.ok).toBe(true);
    expect(outcome.changedFiles).toEqual(['src/a/index.ts']); // HOST-derived, not the peer's self-report
    expect(JSON.stringify(listManifests(repo))).toContain('src/a/index.ts'); // exactly what crossed, no cred/host-path
  });

  it('FAN-OUT SAFETY: a feature ticket borns the ONE shared engineer agent collab — every lane inherits it, no race', async () => {
    const { projectId } = await collabProject('collab:peerB:codex');
    await intakeTicket(runtime.engine, {
      projectId,
      title: 'add a new feature: widget',
      body: '',
      mode: 'preview',
    });
    // Feature fans out; ALL engineer lanes reference roleAgentId['engineer'] = this ONE agent (engine.ts),
    // so borning it once covers every lane — no lane left local, no mid-flight retarget.
    expect(getAgent(`ag-${projectId}-engineer`)?.provider).toBe('collab:peerB:codex');
  });

  it('FAIL-CLOSED not-routable: born collab but peer NOT admitted → PARK/escalate, NEVER silent local', async () => {
    const { projectId } = await collabProject('collab:peerB:codex'); // no peer admitted this test
    await intakeTicket(runtime.engine, {
      projectId,
      title: 'fix the sum bug',
      body: '',
      mode: 'preview',
    });
    expect(getAgent(`ag-${projectId}-engineer`)?.provider).toBe('collab:peerB:codex');

    const { ticketId, taskId } = implTask(projectId);
    const runner = createProductionStageRunner({ bus: new EventBus(), now: () => 1 });
    const outcome = await runner.run({ ticketId, task: getTask(taskId)!, template: implTemplate });
    expect(outcome.ok).toBe(false);
    expect(outcome.escalate).toBe(true);
    expect(outcome.output).toContain('not routable'); // fail-closed, NOT a silent local fall-back
    expect(outcome.changedFiles).toEqual([]);
  });

  it('DEFAULT-OFF: collab:false → engineer born LOCAL (never collab)', async () => {
    const { projectId } = await collabProject(undefined); // routingPolicy.collab = false
    await intakeTicket(runtime.engine, {
      projectId,
      title: 'fix the sum bug',
      body: '',
      mode: 'preview',
    });
    const prov = getAgent(`ag-${projectId}-engineer`)?.provider ?? 'auto';
    expect(prov.startsWith('collab:')).toBe(false); // born-targeting only fires when collab is ON + targeted
  });

  it('REVIEWER-DIFFERS: a collab engineer (vendor codex) → the reviewer avoids codex by VENDOR', () => {
    const policy: ToolPolicy = {
      canRead: true,
      canWrite: false,
      canExecCommands: false,
      network: 'none',
      pathScope: 'own-worktree',
    };
    const ctx = {
      availability: [
        {
          id: 'codex',
          kind: 'local' as const,
          displayName: 'Codex',
          installed: true,
          authenticated: true,
          lastChecked: 1,
        },
        {
          id: 'claude',
          kind: 'local' as const,
          displayName: 'Claude',
          installed: true,
          authenticated: true,
          lastChecked: 1,
        },
      ],
      preferenceOrder: ['codex', 'claude'],
      unmetFor: () => [],
    };
    const r = resolveForInvoke(ctx, {
      policy,
      avoidProvider: 'collab:peerB:codex',
      differ: 'must',
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.provider).toBe('claude'); // vendorOf('collab:peerB:codex')='codex' avoided
  });
});
