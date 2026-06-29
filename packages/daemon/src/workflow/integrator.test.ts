// The real parallel integrator (2c), against REAL git conflicts. Two lanes edit the same line so
// the second merge conflicts; we prove the four load-bearing paths: bounded merge-scoped resolve →
// full-gate → accept; resolver-fails → abort (integration left clean) + escalate; blast-radius →
// escalate IMMEDIATELY (no agent touches sensitive markers); and the works-alone-breaks-together
// backstop (lanes merge clean but the combined suite regresses) → escalate.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WorkflowTemplate } from '@thaloslab/shared';
import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Each test drives real git merges + several pnpm gate runs in a worktree — well past the 5s default.
vi.setConfig({ testTimeout: 30000 });

const dbFile = path.join(os.tmpdir(), `thalos-integ-${process.pid}-${Date.now()}.db`);
process.env.THALOS_DB_PATH = dbFile;

const { openDb, closeDb } = await import('../store/db');
const { runMigrations } = await import('../store/migrate');
const { insertProject } = await import('../store/repositories/projects');
const { insertTicket } = await import('../store/repositories/tickets');
const { insertTask, getTask } = await import('../store/repositories/tasks');
const { EventBus } = await import('./events');
const { createProductionStageRunner } = await import('./stage-runner');
const { setMockProgram, resetMock } = await import('../providers/mock');
const { detectConflicts, ensureIntegrationWorktree } = await import('./worktree');

let repo: string;
let resolverCalls: number;

const template: WorkflowTemplate = {
  id: 'feature',
  label: 'Feature',
  appliesTo: ['feature'],
  mutating: true,
  stages: [{ id: 'integrate', role: 'integrator', produces: ['diff'], dependsOn: ['impl'] }],
  gates: [],
};

// runtests prints PASS/FAIL but ALWAYS exits 0 — so the works-alone backstop is the parsed-result
// regression (combined suite goes red) the exit-code gate can't see, exactly the false-pass case.
const RUNNER = `import { a } from './a.mjs';\nimport { b } from './b.mjs';\nconsole.log((a + b < 2) ? 'PASS combined' : 'FAIL combined');\n`;

beforeEach(async () => {
  try {
    closeDb();
  } catch {
    /* not open yet */
  }
  for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
  runMigrations(openDb());
  resolverCalls = 0;
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'thalos-integ-repo-'));
  const g = simpleGit(repo);
  await g.init(['-b', 'main']);
  await g.addConfig('user.email', 't@localhost', false, 'local');
  await g.addConfig('user.name', 'T', false, 'local');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.thalos/\n');
  fs.writeFileSync(
    path.join(repo, 'package.json'),
    JSON.stringify({
      name: 's',
      type: 'module',
      scripts: {
        test: 'node runtests.mjs',
        build: 'node -e ""',
        typecheck: 'node -e ""',
        lint: 'node -e ""',
      },
    }),
  );
  fs.writeFileSync(path.join(repo, 'runtests.mjs'), RUNNER);
  fs.writeFileSync(path.join(repo, 'a.mjs'), 'export const a = 0;\n');
  fs.writeFileSync(path.join(repo, 'b.mjs'), 'export const b = 0;\n');
  await g.add('.');
  await g.commit('init');
  await g.raw(['branch', 'thalos/integration']);

  insertProject({
    id: 'p',
    name: 'P',
    repoPath: repo,
    origin: 'scratch',
    phase: 'bootstrapping',
    orchestratorProvider: 'claude',
    createdAt: 1,
  });
});

afterEach(() => {
  resetMock();
  fs.rmSync(repo, { recursive: true, force: true });
});

// Create a lane branch off thalos/integration with the given file edits, then return to main so
// the integration worktree can check the branch out.
async function makeLane(lane: string, edits: Record<string, string>): Promise<void> {
  const g = simpleGit(repo);
  await g.checkout(['-b', lane, 'thalos/integration']);
  for (const [f, c] of Object.entries(edits)) fs.writeFileSync(path.join(repo, f), c);
  await g.add('.');
  await g.commit(lane);
  await g.checkout('main');
}

function seedTicket(blastRadius?: string[]): void {
  insertTicket({
    id: 'tk',
    projectId: 'p',
    title: 'feat',
    workflowId: 'feature',
    status: 'running',
    mode: 'mock',
    blastRadius,
    createdAt: 1,
  });
  insertTask({
    id: 'integrate',
    ticketId: 'tk',
    stageId: 'integrate',
    kind: 'stage',
    laneId: 'tk:main',
    dependsOn: ['impl'],
    state: 'running',
    retryCount: 0,
    attempt: 0,
    createdAt: 1,
  });
  for (const i of [0, 1]) {
    insertTask({
      id: `impl${i}`,
      ticketId: 'tk',
      stageId: 'impl',
      kind: 'stage',
      laneId: `tk:seam-${i}`,
      branch: `thalos/lane-tk-seam-${i}`,
      seamPaths: ['.'],
      dependsOn: [],
      state: 'passed',
      retryCount: 0,
      attempt: 0,
      createdAt: 1,
    });
  }
}

describe('parallel integrator + conflict orchestration', () => {
  it('bounded merge-scoped RESOLVE → full gate → accept (ok)', async () => {
    await makeLane('thalos/lane-tk-seam-0', { 'a.mjs': 'export const a = 1;\n' });
    await makeLane('thalos/lane-tk-seam-1', { 'a.mjs': 'export const a = 9;\n' });
    seedTicket();
    setMockProgram(() => {
      resolverCalls++;
      return { ok: true, writeFiles: { 'a.mjs': 'export const a = 1;\n' } }; // resolve to a valid value
    });

    const outcome = await createProductionStageRunner({ bus: new EventBus() }).run({
      ticketId: 'tk',
      task: getTask('integrate')!,
      template,
    });

    expect(outcome.ok).toBe(true);
    expect(resolverCalls).toBeGreaterThan(0);
  });

  it('resolver FAILS → abort (integration left clean) + escalate, naming the conflicted file', async () => {
    await makeLane('thalos/lane-tk-seam-0', { 'a.mjs': 'export const a = 1;\n' });
    await makeLane('thalos/lane-tk-seam-1', { 'a.mjs': 'export const a = 9;\n' });
    seedTicket();
    setMockProgram(() => {
      resolverCalls++;
      return { ok: true }; // no-op — leaves the conflict markers in place
    });

    const outcome = await createProductionStageRunner({ bus: new EventBus() }).run({
      ticketId: 'tk',
      task: getTask('integrate')!,
      template,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.escalate).toBe(true);
    expect(outcome.output).toContain('a.mjs');
    // The merge was aborted — no conflict markers dangling on the integration branch.
    const integDir = await ensureIntegrationWorktree(repo);
    expect(await detectConflicts(integDir)).toEqual([]);
  });

  it('blast-radius conflict → escalate IMMEDIATELY (no resolver agent invoked)', async () => {
    await makeLane('thalos/lane-tk-seam-0', { 'a.mjs': 'export const a = 1;\n' });
    await makeLane('thalos/lane-tk-seam-1', { 'a.mjs': 'export const a = 9;\n' });
    seedTicket(['auth']);
    setMockProgram(() => {
      resolverCalls++;
      return { ok: true };
    });

    const outcome = await createProductionStageRunner({ bus: new EventBus() }).run({
      ticketId: 'tk',
      task: getTask('integrate')!,
      template,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.escalate).toBe(true);
    expect(outcome.output).toContain('blast-radius');
    expect(resolverCalls).toBe(0); // no agent touched the sensitive merge markers
  });

  it('works-alone-breaks-together: lanes merge clean but the combined suite regresses → escalate', async () => {
    await makeLane('thalos/lane-tk-seam-0', { 'a.mjs': 'export const a = 1;\n' });
    await makeLane('thalos/lane-tk-seam-1', { 'b.mjs': 'export const b = 1;\n' });
    seedTicket();

    const outcome = await createProductionStageRunner({ bus: new EventBus() }).run({
      ticketId: 'tk',
      task: getTask('integrate')!,
      template,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.escalate).toBe(true);
    expect(outcome.output).toContain('combined'); // the regressed test id is named
    expect(resolverCalls).toBe(0); // clean merges — no conflict to resolve
  });
});
