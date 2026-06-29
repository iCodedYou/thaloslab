// 4a teeth test (the no-silent-no-op proof). The gate must read its commands from the WORKTREE where
// the checks run, not from the main repo. The failure mode is INVISIBLE: a wrong-dir read returns an
// empty command map and every gate silently passes having run NOTHING (evalGateCheck treats an absent
// optional command as ok:true). A green Phase 1-3 regression can't catch that, because those repos
// carry the toolchain on BOTH main and the worktree.
//
// So we construct the greenfield-shaped DIVERGENCE: package.json (the toolchain) exists ONLY on
// thalos/integration — the scaffold state, before anything reaches main — and assert the unit gate
// ACTUALLY RUNS the worktree's command and can FAIL there. If the StageRunner regressed to reading
// repoPath, main has no package.json → the unit check no-ops → the failing test would pass silently
// → this test would go green. It is red exactly when the discipline is eroded.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WorkflowTemplate } from '@thaloslab/shared';
import { simpleGit } from 'simple-git';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30000 });

const dbFile = path.join(os.tmpdir(), `thalos-gatedir-${process.pid}-${Date.now()}.db`);
process.env.THALOS_DB_PATH = dbFile;

const { openDb, closeDb } = await import('../store/db');
const { runMigrations } = await import('../store/migrate');
const { insertProject } = await import('../store/repositories/projects');
const { upsertProvider } = await import('../store/repositories/providers');
const { insertTicket } = await import('../store/repositories/tickets');
const { insertTask, getTask } = await import('../store/repositories/tasks');
const { EventBus } = await import('./events');
const { createProductionStageRunner } = await import('./stage-runner');
const { detectGateCommands } = await import('./gates');
const { setMockProgram, resetMock } = await import('../providers/mock');

const INTEGRATION = 'thalos/integration';

const template: WorkflowTemplate = {
  id: 'mini',
  label: 'Mini',
  appliesTo: ['feature'],
  mutating: true,
  stages: [{ id: 'impl', role: 'engineer', produces: ['diff'], dependsOn: [] }],
  gates: [{ id: 'impl-green', kind: 'automated', after: 'impl', checks: ['unit'], blocking: true }],
};

const pkg = (testScript: string) =>
  JSON.stringify({
    name: 's',
    type: 'module',
    scripts: { build: 'node -e ""', typecheck: 'node -e ""', lint: 'node -e ""', test: testScript },
  });

let repo: string;

/** Build a repo where main has ONLY a README (no toolchain), and thalos/integration carries the
 *  scaffold's package.json with the given `test` script. Mirrors greenfield post-scaffold-integrate. */
async function setupRepo(testScript: string): Promise<void> {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'thalos-gatedir-repo-'));
  const git = simpleGit(repo);
  await git.init(['-b', 'main']);
  await git.addConfig('user.email', 't@localhost', false, 'local');
  await git.addConfig('user.name', 'T', false, 'local');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.thalos/\n');
  fs.writeFileSync(path.join(repo, 'README.md'), '# mvp\n'); // main: README only, NO package.json
  await git.add('.');
  await git.commit('init');

  // Scaffold lands on thalos/integration only (package.json off main).
  await git.raw(['branch', INTEGRATION]);
  const intg = fs.mkdtempSync(path.join(os.tmpdir(), 'thalos-gatedir-intg-'));
  await git.raw(['worktree', 'add', intg, INTEGRATION]);
  const ig = simpleGit(intg);
  fs.writeFileSync(path.join(intg, 'package.json'), pkg(testScript));
  await ig.add('.');
  await ig.commit('scaffold toolchain');
  await git.raw(['worktree', 'remove', intg, '--force']);

  insertProject({
    id: 'p',
    name: 'P',
    repoPath: repo,
    origin: 'scratch',
    phase: 'bootstrapping',
    orchestratorProvider: 'claude',
    createdAt: 1,
  });
  insertTicket({
    id: 'tk',
    projectId: 'p',
    title: 'mvp',
    workflowId: 'mini',
    status: 'running',
    mode: 'mock',
    createdAt: 1,
  });
  insertTask({
    id: 'impl0',
    ticketId: 'tk',
    stageId: 'impl',
    kind: 'stage',
    laneId: 'tk:main',
    dependsOn: [],
    state: 'running',
    retryCount: 0,
    attempt: 0,
    createdAt: 1,
  });
}

beforeEach(() => {
  try {
    closeDb();
  } catch {
    /* ignore */
  }
  for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
  runMigrations(openDb());
  upsertProvider({
    id: 'claude',
    kind: 'local',
    displayName: 'Claude',
    installed: true,
    authenticated: true,
    lastChecked: 1,
  });
  setMockProgram(() => ({ ok: true, writeFiles: { 'src/x.ts': 'export const x = 1;\n' } }));
});

afterAll(() => {
  resetMock();
  closeDb();
});

describe('gate commands are read from the worktree, not the main repo (no silent no-op)', () => {
  it('the divergence is real: the toolchain is detectable at integration but NOT at main', async () => {
    await setupRepo('node -e ""');
    // Reading main (repoPath) finds no test command → the unit gate would no-op to green.
    expect(detectGateCommands(repo).unit).toBeUndefined();
  });

  it('a FAILING worktree test makes the unit gate FAIL — the gate ran the command where the code is', async () => {
    await setupRepo('node -e "process.exit(1)"'); // toolchain present on integration; unit test RED
    const outcome = await createProductionStageRunner({ bus: new EventBus() }).run({
      ticketId: 'tk',
      task: getTask('impl0')!,
      template,
    });
    // If the StageRunner read repoPath (no package.json on main), the unit check would no-op to
    // ok:true and this stage would PASS. It fails only because the gate ran the worktree's test.
    expect(outcome.ok).toBe(false);
    expect((outcome.output ?? '').toLowerCase()).toMatch(/test|unit|exit/);
  });

  it('a PASSING worktree test lets the unit gate pass — the gate genuinely executes (not always-fail)', async () => {
    await setupRepo('node -e ""'); // toolchain present on integration; unit test GREEN
    const outcome = await createProductionStageRunner({ bus: new EventBus() }).run({
      ticketId: 'tk',
      task: getTask('impl0')!,
      template,
    });
    expect(outcome.ok).toBe(true);
  });
});
