// Two-provider reviewer-differs, end to end in --mock. With claude + codex both installed, the
// BUILDER (engineer) routes to claude (codex can't enforce a per-command allowlist → ineligible),
// and the REVIEWER routes to codex (must differ from the engineer's actual provider). Asserted via
// the LOGICAL run.provider recorded on each run.
//
// TWO CLAIMS DISTINCT: this proves the ROUTER + recording LOGIC across providers; it does NOT prove
// real codex can/can't enforce anything (codex isn't installed; the mock does the invoke).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WorkflowTemplate } from '@thaloslab/shared';
import { simpleGit } from 'simple-git';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30000 });

const dbFile = path.join(os.tmpdir(), `thalos-xprov-${process.pid}-${Date.now()}.db`);
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
  label: 'Mini',
  appliesTo: ['bugfix'],
  mutating: true,
  stages: [
    { id: 'fix', role: 'engineer', produces: ['diff'], dependsOn: [] },
    { id: 'review', role: 'reviewer', produces: ['review'], dependsOn: ['fix'] },
  ],
  gates: [],
};

const provider = (id: string) => ({
  id,
  kind: 'local' as const,
  displayName: id,
  installed: true,
  authenticated: true,
  lastChecked: 1,
});

beforeAll(async () => {
  runMigrations(openDb());
  upsertProvider(provider('claude'));
  upsertProvider(provider('codex')); // two providers installed → the differ rule can engage
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'thalos-xprov-repo-'));
  const git = simpleGit(repo);
  await git.init(['-b', 'main']);
  await git.addConfig('user.email', 't@localhost', false, 'local');
  await git.addConfig('user.name', 'T', false, 'local');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.thalos/\n');
  fs.writeFileSync(
    path.join(repo, 'package.json'),
    JSON.stringify({
      name: 's',
      type: 'module',
      scripts: {
        test: 'node -e ""',
        build: 'node -e ""',
        typecheck: 'node -e ""',
        lint: 'node -e ""',
      },
    }),
  );
  fs.writeFileSync(path.join(repo, 'app.ts'), 'export const v = 1;\n');
  await git.add('.');
  await git.commit('init');

  insertProject({
    id: 'p',
    name: 'P',
    repoPath: repo,
    origin: 'scratch',
    phase: 'maintenance',
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
    id: 'fix1',
    ticketId: 'tk',
    stageId: 'fix',
    kind: 'stage',
    laneId: 'tk:main',
    dependsOn: [],
    state: 'running',
    retryCount: 0,
    attempt: 0,
    createdAt: 1,
  });
  insertTask({
    id: 'review1',
    ticketId: 'tk',
    stageId: 'review',
    kind: 'stage',
    laneId: 'tk:main',
    dependsOn: ['fix'],
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

describe('cross-provider reviewer-differs (end to end, --mock)', () => {
  it('builder → claude (allowlist-capable); reviewer → codex (differs)', async () => {
    setMockProgram((opts) =>
      opts.prompt.includes('role: engineer')
        ? { ok: true, writeFiles: { 'app.ts': 'export const v = 2;\n' } }
        : { ok: true, output: 'APPROVE' },
    );
    const runner = createProductionStageRunner({ bus: new EventBus() });

    await runner.run({ ticketId: 'tk', task: getTask('fix1')!, template });
    await runner.run({ ticketId: 'tk', task: getTask('review1')!, template });

    const fixProvider = recentRunsForTask('fix1')[0]?.provider;
    const reviewProvider = recentRunsForTask('review1')[0]?.provider;

    expect(fixProvider).toBe('claude'); // codex can't enforce the builder's command allowlist
    expect(reviewProvider).toBe('codex'); // reviewer must differ from the engineer's provider
    expect(reviewProvider).not.toBe(fixProvider);
  });
});
