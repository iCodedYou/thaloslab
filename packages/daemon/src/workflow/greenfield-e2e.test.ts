// 4b/4c deterministic --mock acceptance bar (the standing proof; the --live smoke is opt-in in 4c).
// Proves greenfield bootstrapping end to end on a REAL git repo + the production StageRunner:
//  1. a scratch (phase=bootstrapping) project's first ticket routes to the greenfield template (by
//     PHASE, not triage), runs spec → spec-signoff → scaffold → scaffold-integrate → decompose →
//     N impl lanes → integrate → security → pre-ship → done; main is NEVER touched. scaffold-integrate
//     tolerates the intentionally-RED acceptance suite (confirm #4).
//  2. the Bootstrapping→Maintenance transition: on terminal `done`, project.phase flips to maintenance
//     (DB + config mirror), and a SECOND ticket proves BOTH halves — it routes to maintenance assembly
//     AND its gates now detect the real package.json the scaffold committed (the baseline was BORN).
//  3. integration-sweep has TEETH: a seam left unimplemented stays RED on the combined tree →
//     integration-sweep FAILS → ticket does NOT reach done → phase does NOT flip. impl-green is
//     compile-level, so the bad seam survives per-lane and is caught where the MVP-exists claim lives.
//  4. partial failure stays INERT: an impl lane fails → escalate → phase STAYS bootstrapping under
//     repeated advance() (absorbing) → a retry intake re-selects greenfield.
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
// The DURABLE acceptance suite the scaffold commits: whole-MVP RED until BOTH seams land. impl-green
// never runs it (compile-level); integration-sweep runs it on the combined tree (the MVP-exists gate).
const ACCEPTANCE = [
  "import { a } from './src/a/index.mjs';",
  "import { b } from './src/b/index.mjs';",
  'let ok = true;',
  "if (a() !== 1) { console.error('acceptance: a() !== 1'); ok = false; }",
  "if (b() !== 2) { console.error('acceptance: b() !== 2'); ok = false; }",
  'if (!ok) process.exit(1);',
  "console.log('acceptance PASS');",
].join('\n');
const PKG = JSON.stringify({
  name: 'mvp',
  type: 'module',
  scripts: { build: NOOP, typecheck: NOOP, lint: NOOP, test: 'node acceptance.mjs' },
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

/** Script the greenfield roster deterministically.
 *  - failSeam: that engineer's invocation fails outright (agent error).
 *  - brokenSeam: that engineer writes a COMPILING-but-WRONG impl (passes compile-level impl-green,
 *    fails the behavioral integration-sweep) — the "seam left unimplemented" case. */
function greenfieldMock(opts: { failSeam?: string; brokenSeam?: string } = {}) {
  const { failSeam, brokenSeam } = opts;
  const seam = (name: 'a' | 'b', value: number) => ({
    [`src/${name}/index.mjs`]: `export const ${name} = () => ${value};\n`,
  });
  return (invoke: InvokeOptions): MockBehavior => {
    const p = invoke.prompt;
    if (p.includes('Stage: spec')) {
      return {
        ok: true,
        writeFiles: {
          'docs/mvp-spec.md':
            '# MVP\n## Acceptance criteria (testable)\n- src/a exports a()===1\n- src/b exports b()===2\n## Seams\n- src/a\n- src/b\n',
        },
      };
    }
    if (p.includes('Stage: scaffold') && !p.includes('Stage: scaffold-integrate')) {
      // Toolchain + skeleton/contract stubs (return 0) + the whole-MVP RED acceptance suite.
      return {
        ok: true,
        writeFiles: {
          'package.json': PKG,
          'acceptance.mjs': ACCEPTANCE,
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
      return { ok: true, writeFiles: seam('a', brokenSeam === 'src/a' ? 9 : 1) };
    }
    if (p.includes('src/b')) {
      if (failSeam === 'src/b') return { ok: false, output: 'engineer B could not implement' };
      return { ok: true, writeFiles: seam('b', brokenSeam === 'src/b' ? 9 : 2) };
    }
    return { ok: true };
  };
}

/** Drive a ticket: advance + auto-approve human gates until terminal or the tick budget runs out. */
async function drive(
  runtime: ReturnType<typeof createRuntime>,
  id: string,
  max = 40,
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

const passed = (id: string, stageId: string) =>
  listTasksByTicket(id).some((t) => t.stageId === stageId && ['passed', 'done'].includes(t.state));

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
    expect(ticket.workflowId).toBe('greenfield'); // chosen by PHASE, not triage

    await drive(runtime, ticket.id);
    expect(getTicket(ticket.id)?.status).toBe('done');

    // scaffold-integrate passed despite the whole-MVP RED acceptance suite (confirm #4).
    expect(passed(ticket.id, 'scaffold-integrate')).toBe(true);

    // Two isolated impl lanes over the designed (invented) seams.
    const impls = listTasksByTicket(ticket.id).filter((t) => t.stageId === 'impl');
    expect(new Set(impls.map((t) => t.laneId)).size).toBe(2);

    const git = simpleGit(repo);
    expect(await git.show(['thalos/integration:src/a/index.mjs'])).toContain('a = () => 1');
    expect(await git.show(['thalos/integration:src/b/index.mjs'])).toContain('b = () => 2');
    expect(await git.show(['thalos/integration:docs/mvp-spec.md'])).toContain(
      'Acceptance criteria',
    );
    expect((await git.revparse(['main'])).trim()).toBe(mainHead); // main NEVER touched

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
      mode: 'preview',
    });
    expect(t2.workflowId).toBe('bug-fix'); // no longer greenfield — normal maintenance assembly

    // The baseline was BORN: gates now detect the scaffold's package.json on integration (where
    // ticket #2's lanes branch from). Differential gating is back, not just the phase column flipped.
    const integDir = await ensureIntegrationWorktree(project!.repoPath);
    const commands = detectGateCommands(integDir);
    expect(commands.unit).toBeDefined();
    expect(commands.build).toBeDefined();
  });
});

describe('integration-sweep is the MVP-exists gate and has TEETH', () => {
  it('a seam left unimplemented → integration-sweep FAILS → not done → phase does NOT flip', async () => {
    await scratchProject('gf-teeth');
    setMockProgram(greenfieldMock({ brokenSeam: 'src/b' })); // B compiles but b()!==2
    const runtime = createRuntime();
    const ticket = await intakeTicket(runtime.engine, {
      projectId: 'gf-teeth',
      title: 'Build a tiny two-module MVP',
      body: 'a 2-seam mvp',
      mode: 'mock',
    });
    await drive(runtime, ticket.id);

    // The broken seam survived compile-level impl-green and reached integrate — then the FULL
    // acceptance suite caught it. If integration-sweep had run nothing (green-because-empty), the
    // ticket would be `done` and the project would have flipped with its criteria unmet.
    expect(passed(ticket.id, 'integrate')).toBe(false); // integration-sweep blocked it
    expect(getTicket(ticket.id)?.status).not.toBe('done');
    expect(getProject('gf-teeth')?.phase).toBe('bootstrapping');
  });
});

describe('greenfield partial failure stays inert (never flips to maintenance)', () => {
  it('an impl lane fails → escalate → phase STAYS bootstrapping under repeated advance → retry re-enters greenfield', async () => {
    await scratchProject('gf2');
    setMockProgram(greenfieldMock({ failSeam: 'src/a' }));
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
    expect(getProject('gf2')?.phase).toBe('bootstrapping');

    // Absorbing: repeated advance() ticks never flip the phase nor re-dispatch.
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
