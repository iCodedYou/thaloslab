import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GateDef, StageDef, WorkflowTemplate } from '@thaloslab/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
// Type-only import (erased — does not load the engine module before THALOS_DB_PATH is set).
import type { StageOutcome, StageRunner } from './engine';

// Throwaway temp DB before opening the store.
const dbFile = path.join(os.tmpdir(), `thalos-engine-${process.pid}-${Date.now()}.db`);
process.env.THALOS_DB_PATH = dbFile;

const { openDb, closeDb } = await import('../store/db');
const { runMigrations } = await import('../store/migrate');
const { insertProject } = await import('../store/repositories/projects');
const { getTicket, setTicketStatus } = await import('../store/repositories/tickets');
const { listTasksByTicket, getTask, updateTask } = await import('../store/repositories/tasks');
const { listGatesByTicket } = await import('../store/repositories/gates');
const { insertRun, recentRunsForTask } = await import('../store/repositories/runs');
const { EventBus } = await import('./events');
const { createEngine } = await import('./engine');
const { recoverInFlight } = await import('./recovery');
const { genId } = await import('../util/id');

function stage(id: string, dependsOn: string[] = [], loop?: { retryCap: number }): StageDef {
  return {
    id,
    role: 'engineer',
    produces: [],
    dependsOn,
    ...(loop ? { loop: { until: 'gates-green' as const, retryCap: loop.retryCap } } : {}),
  };
}
function humanGate(id: string, after: string): GateDef {
  return { id, kind: 'human', after, blocking: true, prompt: 'Approve the plan?' };
}
function tmpl(id: string, stages: StageDef[], gates: GateDef[] = []): WorkflowTemplate {
  return { id, label: id, appliesTo: ['bugfix'], mutating: true, stages, gates };
}

const templates = new Map<string, WorkflowTemplate>();

/** Build an engine whose StageRunner is scripted by `script(stageId, task)`. Tracks call counts. */
function makeEngine(
  script: (stageId: string) => StageOutcome,
  config?: { retryCap?: number; attemptCap?: number },
) {
  const calls = new Map<string, number>();
  const runner: StageRunner = {
    run: ({ task }) => {
      calls.set(task.stageId, (calls.get(task.stageId) ?? 0) + 1);
      return Promise.resolve(script(task.stageId));
    },
  };
  const engine = createEngine({
    stageRunner: runner,
    resolveTemplate: (t) => templates.get(t.workflowId ?? '')!,
    bus: new EventBus(),
    config,
  });
  return { engine, calls };
}

beforeAll(() => {
  runMigrations(openDb());
  insertProject({
    id: 'p',
    name: 'P',
    repoPath: '/tmp/p',
    origin: 'scratch',
    phase: 'bootstrapping',
    orchestratorProvider: 'claude',
    createdAt: 1,
  });
});
afterAll(() => {
  closeDb();
  for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
});
beforeEach(() => templates.clear());

const OK: StageOutcome = { ok: true, changedFiles: [] };

describe('shape (a): fan-out → parallel → join, single-flight under concurrent advance()', () => {
  it('completes the diamond and dispatches each task exactly once despite concurrent triggers', async () => {
    const t = tmpl('diamond', [
      stage('root'),
      stage('A', ['root']),
      stage('B', ['root']),
      stage('join', ['A', 'B']),
    ]);
    templates.set(t.id, t);
    const { engine, calls } = makeEngine(() => OK);

    const ticket = engine.createTicketFromTemplate({
      projectId: 'p',
      title: 'diamond',
      template: t,
      mode: 'mock',
    });
    // Fire several concurrent advance() triggers (WS + REST + recovery could all race).
    await Promise.all([
      engine.advance(ticket.id),
      engine.advance(ticket.id),
      engine.advance(ticket.id),
    ]);

    expect(getTicket(ticket.id)?.status).toBe('done');
    for (const id of ['root', 'A', 'B', 'join']) {
      expect(calls.get(id), `stage ${id} dispatched once`).toBe(1);
    }
    expect(listTasksByTicket(ticket.id).every((x) => x.state === 'done')).toBe(true);
  });
});

describe('shape (b): retryCap and attemptCap escalate independently', () => {
  it('retry-cap: gate fails with distinct signatures hit the per-loop cap', async () => {
    const t = tmpl('retrycap', [stage('fix', [], { retryCap: 3 })]);
    templates.set(t.id, t);
    let n = 0;
    const { engine, calls } = makeEngine(
      () => ({ ok: false, changedFiles: [`f${n++}.ts`], errorSignature: `sig-${n}` }),
      { attemptCap: 99 }, // ensure the per-loop retryCap is what fires
    );
    const ticket = engine.createTicketFromTemplate({
      projectId: 'p',
      title: 'rc',
      template: t,
      mode: 'mock',
    });
    await engine.advance(ticket.id);

    expect(getTicket(ticket.id)?.status).toBe('escalated');
    const fix = listTasksByTicket(ticket.id).find((x) => x.stageId === 'fix');
    expect(fix?.state).toBe('escalated');
    expect(fix?.retryCount).toBe(3);
    expect(fix?.attempt).toBe(0); // never bounced through review
    expect(calls.get('fix')).toBe(3);
  });

  it('attempt-cap: review bounce-backs hit the whole-loop cap even with a high retryCap', async () => {
    const t = tmpl('attemptcap', [stage('fix', [], { retryCap: 99 })]);
    templates.set(t.id, t);
    const { engine, calls } = makeEngine(
      () => ({ ok: true, changedFiles: [], reviewRejected: true }),
      {
        attemptCap: 4,
      },
    );
    const ticket = engine.createTicketFromTemplate({
      projectId: 'p',
      title: 'ac',
      template: t,
      mode: 'mock',
    });
    await engine.advance(ticket.id);

    expect(getTicket(ticket.id)?.status).toBe('escalated');
    const fix = listTasksByTicket(ticket.id).find((x) => x.stageId === 'fix');
    expect(fix?.attempt).toBe(4);
    expect(fix?.retryCount).toBe(0); // independent of the per-loop cap
    expect(calls.get('fix')).toBe(4);
  });
});

describe('shape (c): human-gate suspend → resume (approve / reject / request-changes)', () => {
  function gateTemplate() {
    return tmpl(
      'gated',
      [stage('prep'), stage('build', ['signoff'])],
      [humanGate('signoff', 'prep')],
    );
  }

  it('approve: parks blocked, then resumes to done', async () => {
    const t = gateTemplate();
    templates.set(t.id, t);
    const { engine } = makeEngine(() => OK);
    const ticket = engine.createTicketFromTemplate({
      projectId: 'p',
      title: 'g',
      template: t,
      mode: 'mock',
    });
    await engine.advance(ticket.id);

    expect(getTicket(ticket.id)?.status).toBe('blocked');
    const gate = listGatesByTicket(ticket.id).find((g) => g.status === 'pending');
    expect(gate).toBeDefined();

    await engine.resolveHumanGate(gate!.id, 'approve', 'user');
    expect(getTicket(ticket.id)?.status).toBe('done');
  });

  it('reject: parks then fails the ticket', async () => {
    const t = gateTemplate();
    templates.set(t.id, t);
    const { engine } = makeEngine(() => OK);
    const ticket = engine.createTicketFromTemplate({
      projectId: 'p',
      title: 'g',
      template: t,
      mode: 'mock',
    });
    await engine.advance(ticket.id);
    const gate = listGatesByTicket(ticket.id).find((g) => g.status === 'pending')!;

    await engine.resolveHumanGate(gate.id, 'reject', 'user');
    expect(getTicket(ticket.id)?.status).toBe('failed');
    expect(listTasksByTicket(ticket.id).find((x) => x.stageId === 'build')?.state).toBe('pending');
  });

  it('request-changes: re-runs the upstream stage and re-parks, then approve → done', async () => {
    const t = gateTemplate();
    templates.set(t.id, t);
    const { engine, calls } = makeEngine(() => OK);
    const ticket = engine.createTicketFromTemplate({
      projectId: 'p',
      title: 'g',
      template: t,
      mode: 'mock',
    });
    await engine.advance(ticket.id);
    expect(calls.get('prep')).toBe(1);

    const gate1 = listGatesByTicket(ticket.id).find((g) => g.status === 'pending')!;
    await engine.resolveHumanGate(gate1.id, 'request-changes', 'user', 'redo it');
    expect(calls.get('prep')).toBe(2); // upstream re-ran
    expect(getTicket(ticket.id)?.status).toBe('blocked'); // re-parked

    const gate2 = listGatesByTicket(ticket.id).find((g) => g.status === 'pending')!;
    expect(gate2.id).not.toBe(gate1.id);
    await engine.resolveHumanGate(gate2.id, 'approve', 'user');
    expect(getTicket(ticket.id)?.status).toBe('done');
  });
});

describe('shape (d): mid-flight crash → recoverInFlight → reconcile → completes, no dup runs', () => {
  it('reaps the interrupted run, leaves passed work alone, and finishes', async () => {
    const t = tmpl('recover', [stage('A'), stage('B', ['A'])]);
    templates.set(t.id, t);
    const { engine, calls } = makeEngine(() => OK);
    const ticket = engine.createTicketFromTemplate({
      projectId: 'p',
      title: 'r',
      template: t,
      mode: 'mock',
    });

    // Construct a mid-flight state: A already passed, B running with an in-flight run (the crash).
    const tasks = listTasksByTicket(ticket.id);
    const a = tasks.find((x) => x.stageId === 'A')!;
    const b = tasks.find((x) => x.stageId === 'B')!;
    updateTask(a.id, { state: 'passed', endedAt: 1 });
    updateTask(b.id, { state: 'running', startedAt: 2 });
    insertRun({
      id: genId('run'),
      taskId: b.id,
      provider: 'mock',
      status: 'running',
      startedAt: 2,
    });
    setTicketStatus(ticket.id, 'running'); // ticket state at crash time

    await recoverInFlight(engine, { reconcile: () => 'pending' });

    // The interrupted run was reaped; A was untouched (NOT re-run); B re-ran; ticket done.
    expect(recentRunsForTask(b.id).some((r) => r.status === 'interrupted')).toBe(true);
    expect(calls.get('A') ?? 0).toBe(0); // completed work not re-executed
    expect(calls.get('B')).toBe(1);
    expect(getTicket(ticket.id)?.status).toBe('done');
    expect(getTask(a.id)?.state).toBe('done');
  });
});

describe('must-fix #4: preview renders the plan and STOPS (never strands)', () => {
  it('creates the task graph but executes nothing and is terminal', async () => {
    const t = tmpl('preview', [stage('fix')]);
    templates.set(t.id, t);
    const { engine, calls } = makeEngine(() => OK);
    const ticket = engine.createTicketFromTemplate({
      projectId: 'p',
      title: 'pv',
      template: t,
      mode: 'preview',
    });
    await engine.advance(ticket.id); // must be a no-op in preview

    expect(getTicket(ticket.id)?.status).toBe('preview-complete');
    expect(calls.size).toBe(0); // zero agent runs
    expect(listTasksByTicket(ticket.id).every((x) => x.state === 'pending')).toBe(true);
  });
});
