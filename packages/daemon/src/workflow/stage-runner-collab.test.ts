// The StageRunner's collab-dispatch short-circuit is WIRED and FAIL-CLOSED, BEFORE any worktree / invoke
// side effect. The DECISION logic is exhaustively unit-tested in collab-route.test.ts, and the full
// round-trip + throw-path fail-closed cases in collab-dispatch.test.ts; here we prove the wiring translates
// a decision correctly: a PARK escalates (never runs), and a collab decision with no live link (peer
// revoked/absent since routing) fails closed — never a silent no-op, never a fall-through to a local run.
import os from 'node:os';
import path from 'node:path';
import type { WorkflowTemplate } from '@thaloslab/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dbFile = path.join(os.tmpdir(), `thalos-srcollab-${process.pid}-${Date.now()}.db`);
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
    repoPath: path.join(os.tmpdir(), 'thalos-srcollab-norepo'),
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
  for (const id of ['park0', 'collab0']) {
    insertTask({
      id,
      ticketId: 'tk',
      stageId: 'impl',
      kind: 'stage',
      laneId: `tk:${id}`,
      dependsOn: [],
      state: 'running',
      retryCount: 0,
      attempt: 0,
      createdAt: 1,
    });
  }
});

afterAll(() => {
  closeDb();
});

describe('StageRunner collab-dispatch short-circuit (fail-closed, no side effect)', () => {
  it('a PARK decision ESCALATES before any worktree/invoke (never runs a local fall-back)', async () => {
    const runner = createProductionStageRunner({
      bus: new EventBus(),
      resolveCollab: () => ({ kind: 'park', reason: 'collab peer "mac-1" is not routable' }),
    });
    const outcome = await runner.run({ ticketId: 'tk', task: getTask('park0')!, template });
    expect(outcome.ok).toBe(false);
    expect(outcome.escalate).toBe(true);
    expect(outcome.output).toContain('collab routing failed closed');
    expect(outcome.output).toContain('not routable');
    expect(outcome.changedFiles).toEqual([]); // no side effect
  });

  it('a collab decision with NO live link (peer revoked/absent since routing) FAILS CLOSED — no local fall-back', async () => {
    // Default collabLinkFor → the singleton collabService, where "mac-1" was never admitted → linkFor null.
    const runner = createProductionStageRunner({
      bus: new EventBus(),
      resolveCollab: () => ({
        kind: 'collab',
        peerId: 'mac-1',
        vendor: 'codex',
        providerId: 'collab:mac-1:codex',
      }),
    });
    const outcome = await runner.run({ ticketId: 'tk', task: getTask('collab0')!, template });
    expect(outcome.ok).toBe(false);
    expect(outcome.escalate).toBe(true);
    expect(outcome.output).toContain('link unavailable');
    expect(outcome.output).toContain('mac-1');
    expect(outcome.changedFiles).toEqual([]); // no side effect
  });
});
