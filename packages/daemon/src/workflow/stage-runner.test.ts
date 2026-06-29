import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WorkflowTemplate } from '@thaloslab/shared';
import { simpleGit } from 'simple-git';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dbFile = path.join(os.tmpdir(), `thalos-sr-${process.pid}-${Date.now()}.db`);
process.env.THALOS_DB_PATH = dbFile;

const { openDb, closeDb } = await import('../store/db');
const { runMigrations } = await import('../store/migrate');
const { insertProject } = await import('../store/repositories/projects');
const { upsertProvider } = await import('../store/repositories/providers');
const { insertTicket } = await import('../store/repositories/tickets');
const { insertTask, getTask } = await import('../store/repositories/tasks');
const { recentRunsForTask } = await import('../store/repositories/runs');
const { EventBus } = await import('./events');
const { createProductionStageRunner } = await import('./stage-runner');
const { setMockProgram, resetMock } = await import('../providers/mock');

let repo: string;

const template: WorkflowTemplate = {
  id: 'mini',
  label: 'mini',
  appliesTo: ['bugfix'],
  mutating: true,
  stages: [{ id: 'fix', role: 'engineer', produces: ['diff'], dependsOn: [] }],
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
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'thalos-sr-repo-'));
  const git = simpleGit(repo);
  await git.init(['-b', 'main']);
  await git.addConfig('user.email', 't@localhost', false, 'local');
  await git.addConfig('user.name', 'T', false, 'local');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.thalos/\n');
  fs.writeFileSync(path.join(repo, 'app.ts'), 'export const v = 1;\n');
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
    title: 'bug',
    workflowId: 'mini',
    status: 'running',
    mode: 'mock',
    createdAt: 1,
  });
  insertTask({
    id: 'task1',
    ticketId: 'tk',
    stageId: 'fix',
    kind: 'stage',
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

describe('production StageRunner in --mock', () => {
  it('creates a worktree, runs the mock agent (real file write), audits scope, persists a run', async () => {
    setMockProgram(() => ({
      ok: true,
      writeFiles: { 'app.ts': 'export const v = 2; // fixed\n' },
    }));
    const runner = createProductionStageRunner({ bus: new EventBus() });

    const outcome = await runner.run({ ticketId: 'tk', task: getTask('task1')!, template });

    expect(outcome.ok).toBe(true);
    expect(outcome.changedFiles).toContain('app.ts');

    const task = getTask('task1')!;
    expect(task.worktreePath).toBeTruthy();
    expect(fs.existsSync(path.join(task.worktreePath!, 'app.ts'))).toBe(true);
    expect(fs.readFileSync(path.join(task.worktreePath!, 'app.ts'), 'utf8')).toContain('fixed');

    // A run row was persisted and finalized — recording the LOGICAL routed provider (the seeded
    // claude), NOT the mock adapter id, so routing is auditable even in --mock.
    const runs = recentRunsForTask('task1');
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0]?.status).toBe('ok');
    expect(runs[0]?.provider).toBe('claude');
  });
});
