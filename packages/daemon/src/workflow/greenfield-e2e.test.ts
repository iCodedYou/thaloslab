// 4b deterministic --mock acceptance bar (the standing proof; the --live smoke is opt-in in 4c).
// Proves greenfield bootstrapping end to end on a REAL git repo + the production StageRunner:
//  1. a scratch (phase=bootstrapping) project's first ticket routes to the greenfield template (by
//     PHASE, not triage), runs spec → spec-signoff → scaffold → scaffold-integrate → decompose →
//     N impl lanes → integrate → security → pre-ship → done; main is NEVER touched.
//  2. the Bootstrapping→Maintenance transition: on terminal `done`, project.phase flips to
//     maintenance (DB + config.json mirror), and a SECOND ticket proves BOTH halves at once — it
//     routes to maintenance assembly AND its gates now detect the real package.json the scaffold
//     committed (the baseline was BORN, not just the flag flipped).
//  3. partial failure stays INERT: an impl lane fails → ticket escalates → phase STAYS bootstrapping
//     under repeated advance() ticks (absorbing) → a retry intake re-selects greenfield.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { InvokeOptions, Project } from '@thaloslab/shared';
import { simpleGit } from 'simple-git';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MockBehavior } from '../providers/mock';

vi.setConfig({ testTimeout: 90000 });

const dbFile = path.join(os.tmpdir(), `thalos-gf-${process.pid}-${Date.now()}.db`);
process.env.THALOS_DB_PATH = dbFile;

const { openDb, closeDb } = await import('../store/db');
const { runMigrations } = await import('../store/migrate');
const { insertProject, getProject } = await import('../store/repositories/projects');
const { upsertProvider } = await import('../store/repositories/providers');
const { getTicket } = await import('../store/repositories/tickets');
const { listGatesByTicket } = await import('../store/repositories/gates');
const { listTasksByTicket } = await import('../store/repositories/tasks');
const { detectGateCommands } = await import('./gates');
const { ensureIntegrationWorktree } = await import('./worktree');
const { readThalosConfig, scaffoldThalos } = await import('../store/thalos-layout');
const { createRuntime } = await import('./runtime');
const { intakeTicket } = await import('./orchestrator/intake');
const { setMockProgram, resetMock } = await import('../providers/mock');

const NOOP = 'node -e ""';
const pkg = (testScript = NOOP) =>
  JSON.stringify({
    name: 'mvp',
    type: 'module',
    scripts: { build: NOOP, typecheck: NOOP, lint: NOOP, test: testScript },
  });

/** A from-scratch repo, mirroring project/create.ts: README commit on main + .thalos scaffolded. */
async function scratchProject(id: string): Promise<{ repo: string; mainHead: string }> {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `thalos-gf-${id}-`));
  const git = simpleGit(repo);
  await git.init(['-b', 'main']);
  // Write the identity directly to .git/config rather than via `git config` (which takes a
  // .git/config.lock that can collide under heavy parallel-test load on Windows).
  fs.appendFileSync(
    path.join(repo, '.git', 'config'),
    '[user]\n\temail = t@localhost\n\tname = T\n',
  );
  scaffoldThalos(repo, { phase: 'bootstrapping', orchestratorProvider: 'claude' });
  fs.writeFileSync(path.join(repo, 'README.md'), `# ${id}\n`);
  await git.add('.');
  await git.commit('Initial commit (Thalos Lab)');
  const project: Project = {
    id,
    name: id,
    repoPath: repo,
    origin: 'scratch',
    phase: 'bootstrapping',
    orchestratorProvider: 'claude',
    createdAt: 1,
  };
  insertProject(project);
  return { repo, mainHead: (await git.revparse(['main'])).trim() };
}

/** Script the greenfield roster deterministically. `failSeam` makes that seam's engineer fail;
 *  `scaffoldTest` sets the scaffold's package.json `test` script (e.g. a RED suite). */
function greenfieldMock(opts: { failSeam?: string; scaffoldTest?: string } = {}) {
  const { failSeam, scaffoldTest } = opts;
  return (invoke: InvokeOptions): MockBehavior => {
    const p = invoke.prompt;
    if (p.includes('Stage: spec')) {
      // A DURABLE spec with TESTABLE acceptance criteria + the designed seams.
      return {
        ok: true,
        writeFiles: {
          'docs/mvp-spec.md':
            '# MVP\n## Acceptance criteria (testable)\n- src/a exports a()===1\n- src/b exports b()===2\n## Seams\n- src/a\n- src/b\n',
        },
      };
    }
    if (p.includes('Stage: scaffold') && !p.includes('Stage: scaffold-integrate')) {
      // Materialize the toolchain + skeleton + interface-contract stubs.
      return {
        ok: true,
        writeFiles: {
          'package.json': pkg(scaffoldTest),
          'src/a/index.mjs': 'export const a = () => 0; // TODO\n',
          'src/b/index.mjs': 'export const b = () => 0; // TODO\n',
        },
      };
    }
    if (p.includes('Stage: decompose')) {
      return {
        ok: true,
        writeFiles: {
          'decomposition.json': JSON.stringify([
            { seamPaths: ['src/a'], summary: 'module A' },
            { seamPaths: ['src/b'], summary: 'module B' },
          ]),
        },
      };
    }
    if (p.includes('src/a')) {
      if (failSeam === 'src/a') return { ok: false, output: 'engineer A could not implement' };
      return { ok: true, writeFiles: { 'src/a/index.mjs': 'export const a = () => 1;\n' } };
    }
    if (p.includes('src/b')) {
      if (failSeam === 'src/b') return { ok: false, output: 'engineer B could not implement' };
      return { ok: true, writeFiles: { 'src/b/index.mjs': 'export const b = () => 2;\n' } };
    }
    return { ok: true };
  };
}

/** Drive a ticket: advance + auto-approve human gates until terminal or the tick budget runs out. */
async function drive(
  runtime: ReturnType<typeof createRuntime>,
  id: string,
  max = 30,
): Promise<void> {
  for (let i = 0; i < max; i++) {
    const t = getTicket(id);
    if (!t || ['done', 'failed', 'escalated', 'aborted'].includes(t.status)) break;
    if (t.status === 'blocked') {
      const gate = listGatesByTicket(id).find((g) => g.status === 'pending');
      if (!gate) break;
      await runtime.engine.resolveHumanGate(gate.id, 'approve', 'test');
    } else {
      await runtime.engine.advance(id);
    }
  }
}

beforeAll(() => {
  runMigrations(openDb());
  upsertProvider({
    id: 'claude',
    kind: 'local',
    displayName: 'Claude',
    installed: true,
    authenticated: true,
    lastChecked: 1,
  });
});

afterAll(() => {
  resetMock();
  closeDb();
  for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
});

describe('greenfield bootstrapping (end to end, --mock)', () => {
  it('builds the MVP on integration → done → flips to maintenance; main untouched', async () => {
    const { repo, mainHead } = await scratchProject('gf1');
    setMockProgram(greenfieldMock());
    const runtime = createRuntime();

    const ticket = await intakeTicket(runtime.engine, {
      projectId: 'gf1',
      title: 'Build a tiny two-module MVP',
      body: 'a 2-seam mvp',
      mode: 'mock',
    });
    // Chosen by PHASE, not triage keywords.
    expect(ticket.workflowId).toBe('greenfield');

    await drive(runtime, ticket.id);
    expect(getTicket(ticket.id)?.status).toBe('done');

    // Two isolated impl lanes materialized over the designed (invented) seams.
    const impls = listTasksByTicket(ticket.id).filter((t) => t.stageId === 'impl');
    expect(new Set(impls.map((t) => t.laneId)).size).toBe(2);

    const git = simpleGit(repo);
    // The MVP (incl. the durable spec) landed on thalos/integration…
    expect(await git.show(['thalos/integration:src/a/index.mjs'])).toContain('a = () => 1');
    expect(await git.show(['thalos/integration:src/b/index.mjs'])).toContain('b = () => 2');
    expect(await git.show(['thalos/integration:docs/mvp-spec.md'])).toContain(
      'Acceptance criteria',
    );
    // …and main was NEVER touched (no greenfield landing exception).
    expect((await git.revparse(['main'])).trim()).toBe(mainHead);

    // Bootstrapping→Maintenance flipped on terminal done (DB authoritative + config mirror).
    expect(getProject('gf1')?.phase).toBe('maintenance');
    expect(readThalosConfig(repo)?.phase).toBe('maintenance');
  });

  it('the transition is REAL: ticket #2 uses maintenance assembly AND the baseline was born', async () => {
    const project = getProject('gf1');
    expect(project?.phase).toBe('maintenance');
    const runtime = createRuntime();

    const t2 = await intakeTicket(runtime.engine, {
      projectId: 'gf1',
      title: 'Fix a bug in module a',
      body: 'the a() helper is off by one',
      mode: 'preview', // we only need the routing + baseline assertions, not a full run
    });
    // No longer greenfield — normal maintenance assembly.
    expect(t2.workflowId).toBe('bug-fix');

    // The baseline was BORN: gates now detect the real package.json the scaffold committed to
    // integration (where ticket #2's lanes branch from) — differential gating is back, not just the
    // phase column flipped.
    const integDir = await ensureIntegrationWorktree(project!.repoPath);
    const commands = detectGateCommands(integDir);
    expect(commands.unit).toBeDefined();
    expect(commands.build).toBeDefined();
  });
});

describe('greenfield partial failure stays inert (never flips to maintenance)', () => {
  it('an impl lane fails → escalate → phase STAYS bootstrapping under repeated advance → retry re-enters greenfield', async () => {
    await scratchProject('gf2');
    setMockProgram(greenfieldMock({ failSeam: 'src/a' })); // engineer A fails
    const runtime = createRuntime();

    const ticket = await intakeTicket(runtime.engine, {
      projectId: 'gf2',
      title: 'Build a tiny two-module MVP',
      body: 'a 2-seam mvp',
      mode: 'mock',
    });
    expect(ticket.workflowId).toBe('greenfield');

    await drive(runtime, ticket.id);
    expect(getTicket(ticket.id)?.status).toBe('escalated');
    expect(getProject('gf2')?.phase).toBe('bootstrapping'); // a half-built MVP is NOT finished

    // Absorbing: repeated advance() ticks on the escalated ticket never flip the phase nor re-dispatch.
    for (let i = 0; i < 5; i++) await runtime.engine.advance(ticket.id);
    expect(getTicket(ticket.id)?.status).toBe('escalated');
    expect(getProject('gf2')?.phase).toBe('bootstrapping');

    // A retry (new ticket) correctly RE-ENTERS greenfield (no completed greenfield ticket exists).
    setMockProgram(greenfieldMock());
    const retry = await intakeTicket(runtime.engine, {
      projectId: 'gf2',
      title: 'Build the MVP again',
      body: 'retry',
      mode: 'preview',
    });
    expect(retry.workflowId).toBe('greenfield');
  });
});

describe('scaffold-integrate tolerates the intentionally-red acceptance suite (confirm #4)', () => {
  it('a RED scaffold test does NOT choke scaffold-integrate — the fan-out still expands past it', async () => {
    await scratchProject('gf3');
    // The scaffold suite is RED by design (acceptance criteria not yet implemented). scaffold-green
    // omits `unit`, and scaffold-integrate detects gate commands from integration BEFORE the merge —
    // empty (README only) → no unit sweep — so the red suite cannot fail the integrate pass.
    setMockProgram(greenfieldMock({ scaffoldTest: 'node -e "process.exit(1)"' }));
    const runtime = createRuntime();
    const ticket = await intakeTicket(runtime.engine, {
      projectId: 'gf3',
      title: 'Build a tiny two-module MVP',
      body: 'a 2-seam mvp',
      mode: 'mock',
    });
    await drive(runtime, ticket.id);

    // scaffold-integrate did NOT fail on the red suite: it passed, decompose ran, and the impl lanes
    // materialized (the fan-out expanded past scaffold-integrate).
    const tasks = listTasksByTicket(ticket.id);
    const scaffoldIntegrate = tasks.find((t) => t.stageId === 'scaffold-integrate');
    expect(scaffoldIntegrate?.state === 'passed' || scaffoldIntegrate?.state === 'done').toBe(true);
    expect(tasks.some((t) => t.stageId === 'impl')).toBe(true);
  });
});
