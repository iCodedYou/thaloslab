import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StageOutcome, StageRunner } from '../engine';

const dbFile = path.join(os.tmpdir(), `thalos-intake-${process.pid}-${Date.now()}.db`);
process.env.THALOS_DB_PATH = dbFile;

const { openDb, closeDb } = await import('../../store/db');
const { runMigrations } = await import('../../store/migrate');
const { insertProject } = await import('../../store/repositories/projects');
const { getTicket } = await import('../../store/repositories/tickets');
const { listGatesByTicket } = await import('../../store/repositories/gates');
const { EventBus } = await import('../events');
const { createEngine } = await import('../engine');
const { templateById, bugFixTemplate } = await import('../templates');
const { intakeTicket } = await import('./intake');

const OK: StageOutcome = { ok: true, changedFiles: [] };

function engineWithScript() {
  const runner: StageRunner = { run: () => Promise.resolve(OK) };
  return createEngine({
    stageRunner: runner,
    resolveTemplate: (t) => templateById(t.workflowId ?? '') ?? bugFixTemplate,
    bus: new EventBus(),
  });
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

describe('orchestrator intake → bug-fix template', () => {
  it('triages a bug ticket, parks at plan sign-off, then walks the full DAG to done', async () => {
    const engine = engineWithScript();
    const ticket = await intakeTicket(engine, {
      projectId: 'p',
      title: 'the export button 500s on large datasets',
      mode: 'mock',
    });

    // Triaged as a bug fix on the bug-fix workflow.
    const stored = getTicket(ticket.id);
    expect(stored?.taskType).toBe('bugfix');
    expect(stored?.workflowId).toBe('bug-fix');

    // Parks at the human plan sign-off before any mutating stage.
    expect(stored?.status).toBe('blocked');
    const gate = listGatesByTicket(ticket.id).find((g) => g.status === 'pending');
    expect(gate?.title).toContain('Approve the plan');

    // Approve → the engine walks repro → fix → review → regression → integrate → done.
    await engine.resolveHumanGate(gate!.id, 'approve', 'user');
    expect(getTicket(ticket.id)?.status).toBe('done');
  });

  it('preview renders the plan and stops without executing', async () => {
    const engine = engineWithScript();
    const ticket = await intakeTicket(engine, {
      projectId: 'p',
      title: 'fix the crash in checkout',
      mode: 'preview',
    });
    const stored = getTicket(ticket.id);
    expect(stored?.status).toBe('preview-complete');
    expect(stored?.blastRadius).toContain('payments'); // triage still ran for real
  });
});
