// Proves the PRECISE gates in the production StageRunner: repro-red requires a NEW failing test,
// and the fix gate REJECTS the false-pass where the suite goes green only because the reproduction
// test was deleted — exactly what a suite-level exit-code gate would wave through.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WorkflowTemplate } from '@thaloslab/shared';
import { simpleGit } from 'simple-git';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Real git worktree + several pnpm gate runs + lane commits — well past the 5s default under
// full-suite concurrency.
vi.setConfig({ testTimeout: 30000 });
import type { InvokeOptions } from '@thaloslab/shared';

const dbFile = path.join(os.tmpdir(), `thalos-precise-${process.pid}-${Date.now()}.db`);
process.env.THALOS_DB_PATH = dbFile;

const { openDb, closeDb } = await import('../store/db');
const { runMigrations } = await import('../store/migrate');
const { insertProject } = await import('../store/repositories/projects');
const { insertTicket } = await import('../store/repositories/tickets');
const { insertTask, getTask } = await import('../store/repositories/tasks');
const { EventBus } = await import('./events');
const { createProductionStageRunner } = await import('./stage-runner');
const { setMockProgram, resetMock } = await import('../providers/mock');

let repo: string;

const RUNNER = `import fs from 'node:fs';
const cases = JSON.parse(fs.readFileSync('cases.json', 'utf8'));
let fail = 0;
for (const c of cases) { console.log((c.passed ? 'PASS ' : 'FAIL ') + c.id); if (!c.passed) fail++; }
process.exit(fail > 0 ? 1 : 0);
`;

// repro depends on the plan gate in the real template; here we drive the two stages directly.
const template: WorkflowTemplate = {
  id: 'bug-fix',
  label: 'Bug fix',
  appliesTo: ['bugfix'],
  mutating: true,
  stages: [
    { id: 'repro', role: 'test-author', produces: ['repro-test'], dependsOn: [] },
    { id: 'fix', role: 'engineer', produces: ['diff'], dependsOn: ['repro'] },
  ],
  gates: [
    { id: 'repro-red', kind: 'automated', after: 'repro', checks: ['unit'], blocking: true },
    {
      id: 'fix-green',
      kind: 'automated',
      after: 'fix',
      checks: ['build', 'typecheck', 'lint', 'unit'],
      blocking: true,
    },
  ],
};

beforeAll(async () => {
  runMigrations(openDb());
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'thalos-precise-repo-'));
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
        test: 'node runtests.mjs',
        build: 'node -e ""',
        typecheck: 'node -e ""',
        lint: 'node -e ""',
      },
    }),
  );
  fs.writeFileSync(path.join(repo, 'runtests.mjs'), RUNNER);
  fs.writeFileSync(
    path.join(repo, 'cases.json'),
    JSON.stringify([{ id: 'existing', passed: true }]),
  );
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
    workflowId: 'bug-fix',
    status: 'running',
    mode: 'mock',
    createdAt: 1,
  });
  insertTask({
    id: 'repro1',
    ticketId: 'tk',
    stageId: 'repro',
    kind: 'stage',
    dependsOn: [],
    state: 'running',
    retryCount: 0,
    attempt: 0,
    createdAt: 1,
  });
  insertTask({
    id: 'fix1',
    ticketId: 'tk',
    stageId: 'fix',
    kind: 'stage',
    dependsOn: ['repro'],
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

describe('precise repro/fix gates catch the suite-green-but-repro-deleted false-pass', () => {
  it('repro adds a failing test (repro-red satisfied); the fix gate REJECTS deleting it', async () => {
    setMockProgram((opts: InvokeOptions) => {
      if (opts.prompt.includes('Stage: repro')) {
        return {
          ok: true,
          writeFiles: {
            'cases.json': JSON.stringify([
              { id: 'existing', passed: true },
              { id: 'repro', passed: false },
            ]),
          },
        };
      }
      // fix stage CHEAT: delete the failing reproduction test → suite goes green with no real fix.
      return {
        ok: true,
        writeFiles: { 'cases.json': JSON.stringify([{ id: 'existing', passed: true }]) },
      };
    });

    const runner = createProductionStageRunner({ bus: new EventBus() });

    const reproOutcome = await runner.run({ ticketId: 'tk', task: getTask('repro1')!, template });
    expect(reproOutcome.ok).toBe(true); // a new failing test was added

    const fixOutcome = await runner.run({ ticketId: 'tk', task: getTask('fix1')!, template });
    expect(fixOutcome.ok).toBe(false); // suite is green BUT the repro test is gone → rejected
    expect(fixOutcome.output).toContain('repro');
  });
});
