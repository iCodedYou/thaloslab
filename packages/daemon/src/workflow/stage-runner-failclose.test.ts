// The fail-closed safety invariant, end to end: when a role's required least-privilege policy can
// be enforced by NO installed provider, the production StageRunner REFUSES — it escalates before any
// worktree/invoke side effect. The unsafe path actually refuses (asserted, not assumed).
import os from 'node:os';
import path from 'node:path';
import type { WorkflowTemplate } from '@thaloslab/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dbFile = path.join(os.tmpdir(), `thalos-failclose-${process.pid}-${Date.now()}.db`);
process.env.THALOS_DB_PATH = dbFile;

const { openDb, closeDb } = await import('../store/db');
const { runMigrations } = await import('../store/migrate');
const { insertProject } = await import('../store/repositories/projects');
const { insertTicket } = await import('../store/repositories/tickets');
const { insertTask, getTask } = await import('../store/repositories/tasks');
const { EventBus } = await import('./events');
const { createProductionStageRunner } = await import('./stage-runner');

const template: WorkflowTemplate = {
  id: 'feature',
  label: 'Feature',
  appliesTo: ['feature'],
  mutating: true,
  stages: [{ id: 'impl', role: 'engineer', produces: ['diff'], dependsOn: [] }],
  gates: [],
};

beforeAll(() => {
  runMigrations(openDb());
  insertProject({
    id: 'p',
    name: 'P',
    repoPath: path.join(os.tmpdir(), 'thalos-failclose-norepo'),
    origin: 'scratch',
    phase: 'maintenance',
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
    laneId: 'tk:main',
    dependsOn: [],
    state: 'running',
    retryCount: 0,
    attempt: 0,
    createdAt: 1,
  });
});

afterAll(() => {
  closeDb();
});

describe('provider fail-closed', () => {
  it('escalates (never invokes) when no installed provider can enforce the role policy', async () => {
    // Injected router: a provider is installed+authed but reports a required constraint UNMET.
    const runner = createProductionStageRunner({
      bus: new EventBus(),
      routerCtx: () => ({
        availability: [
          {
            id: 'codex',
            kind: 'local',
            displayName: 'Codex',
            installed: true,
            authenticated: true,
            lastChecked: 1,
          },
        ],
        preferenceOrder: ['codex'],
        unmetFor: () => ['command-allowlist'], // can't express the builder's per-command allowlist
      }),
    });

    const outcome = await runner.run({ ticketId: 'tk', task: getTask('impl0')!, template });

    expect(outcome.ok).toBe(false);
    expect(outcome.escalate).toBe(true);
    expect(outcome.output).toContain('failed closed');
    expect(outcome.output).toContain('command-allowlist');
  });
});
