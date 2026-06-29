// Path-ownership is CHECKED, not hoped: a fan-out engineer that edits a file outside its declared
// seam fails the run as a scope breach (production StageRunner + real worktree, --mock).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WorkflowTemplate } from '@thaloslab/shared';
import { simpleGit } from 'simple-git';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Real git worktree + agent run — raise above the 5s default for full-suite concurrency.
vi.setConfig({ testTimeout: 30000 });

const dbFile = path.join(os.tmpdir(), `thalos-seam-${process.pid}-${Date.now()}.db`);
process.env.THALOS_DB_PATH = dbFile;

const { openDb, closeDb } = await import('../store/db');
const { runMigrations } = await import('../store/migrate');
const { insertProject } = await import('../store/repositories/projects');
const { upsertProvider } = await import('../store/repositories/providers');
const { insertTicket } = await import('../store/repositories/tickets');
const { insertTask, getTask } = await import('../store/repositories/tasks');
const { EventBus } = await import('./events');
const { createProductionStageRunner } = await import('./stage-runner');
const { setMockProgram, resetMock } = await import('../providers/mock');

let repo: string;

const template: WorkflowTemplate = {
  id: 'feature',
  label: 'Feature',
  appliesTo: ['feature'],
  mutating: true,
  stages: [{ id: 'impl', role: 'engineer', produces: ['diff'], dependsOn: [] }],
  gates: [],
};

beforeAll(async () => {
  runMigrations(openDb());
  upsertProvider({
    id: 'claude',
    kind: 'local',
    displayName: 'Claude',
    installed: true,
    authenticated: true,
    lastChecked: 1,
  });
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'thalos-seam-repo-'));
  const git = simpleGit(repo);
  await git.init(['-b', 'main']);
  await git.addConfig('user.email', 't@localhost', false, 'local');
  await git.addConfig('user.name', 'T', false, 'local');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.thalos/\n');
  fs.mkdirSync(path.join(repo, 'src', 'a'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src', 'b'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'a', 'x.ts'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(repo, 'src', 'b', 'y.ts'), 'export const y = 1;\n');
  await git.add('.');
  await git.commit('init');

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
    title: 'feat',
    workflowId: 'feature',
    status: 'running',
    mode: 'mock',
    createdAt: 1,
  });
  insertTask({
    id: 'impl0',
    ticketId: 'tk',
    stageId: 'impl',
    kind: 'stage',
    laneId: 'tk:seam-0',
    seamPaths: ['src/a'],
    dependsOn: [],
    state: 'running',
    retryCount: 0,
    attempt: 0,
    createdAt: 1,
  });
});

afterAll(() => {
  resetMock();
  closeDb();
  fs.rmSync(repo, { recursive: true, force: true });
  for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
});

describe('lane path-ownership audit', () => {
  it('fails the run when an engineer edits a file outside its declared seam', async () => {
    // The lane owns src/a, but the agent edits the (tracked) src/b/y.ts.
    setMockProgram(() => ({
      ok: true,
      writeFiles: { 'src/b/y.ts': 'export const y = 2; // sneaky\n' },
    }));
    const runner = createProductionStageRunner({ bus: new EventBus() });

    const outcome = await runner.run({ ticketId: 'tk', task: getTask('impl0')!, template });

    expect(outcome.ok).toBe(false);
    expect(outcome.scopeViolation).toBe(true);
    expect(outcome.output).toContain('src/b/y.ts');
  });
});
