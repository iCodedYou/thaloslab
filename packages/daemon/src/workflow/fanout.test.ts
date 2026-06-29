// Dynamic fan-out (2b), deterministic via a scripted StageRunner. Proves: N isolated lanes
// materialize from the architect's decomposition and run concurrently IN WAVES under the throughput
// cap; a 1-unit decomposition stays sequential; partial failure escalates the ticket and RETAINS
// surviving lanes (integrate never fires); expansion is idempotent (post-crash re-advance makes no
// duplicates); an overlapping or invalid decomposition is rejected; re-expansion is bounded.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WorkflowTemplate } from '@thaloslab/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { WorkItem } from './decomposition';
import type { StageOutcome, StageRunContext } from './engine';

const dbFile = path.join(os.tmpdir(), `thalos-fanout-${process.pid}-${Date.now()}.db`);
process.env.THALOS_DB_PATH = dbFile;

const { openDb, closeDb } = await import('../store/db');
const { runMigrations } = await import('../store/migrate');
const { insertProject } = await import('../store/repositories/projects');
const { listTasksByTicket } = await import('../store/repositories/tasks');
const { getTicket } = await import('../store/repositories/tickets');
const { listGatesByTicket } = await import('../store/repositories/gates');
const { createEngine } = await import('./engine');
const { EventBus } = await import('./events');
const { writeDecomposition } = await import('./decomposition');

let repoPath: string;

const FANOUT_STAGE = {
  id: 'plan',
  role: 'architect' as const,
  fanOut: { childRole: 'engineer' as const, childStageId: 'impl', fromArtifact: 'plan' as const },
  produces: ['plan' as const],
  dependsOn: [],
};

const withIntegrate: WorkflowTemplate = {
  id: 'feature',
  label: 'Feature',
  appliesTo: ['feature'],
  mutating: true,
  stages: [
    FANOUT_STAGE,
    { id: 'integrate', role: 'integrator', produces: ['diff'], dependsOn: ['impl'] },
  ],
  gates: [],
};

const gatedNoIntegrate: WorkflowTemplate = {
  id: 'feature-gated',
  label: 'Feature (gated)',
  appliesTo: ['feature'],
  mutating: true,
  stages: [FANOUT_STAGE],
  gates: [{ id: 'plan-signoff', kind: 'human', after: 'plan', blocking: true }],
};

interface Cfg {
  template: WorkflowTemplate;
  decomp: WorkItem[] | null;
  failLane: string | null;
  maxConcurrent: number;
  inFlight: number;
  peak: number;
  calls: number;
}
let cfg: Cfg;

function makeEngine() {
  const runner = {
    async run(ctx: StageRunContext): Promise<StageOutcome> {
      const { task, ticketId } = ctx;
      cfg.calls++;
      cfg.inFlight++;
      cfg.peak = Math.max(cfg.peak, cfg.inFlight);
      await Promise.resolve();
      await Promise.resolve();
      let outcome: StageOutcome;
      if (task.stageId === 'plan') {
        if (cfg.decomp) writeDecomposition(repoPath, ticketId, cfg.decomp);
        outcome = { ok: true, changedFiles: [] };
      } else if (task.stageId === 'impl') {
        outcome =
          cfg.failLane && task.laneId.endsWith(cfg.failLane)
            ? { ok: false, changedFiles: [], output: 'boom', errorSignature: 'boom' }
            : { ok: true, changedFiles: [] };
      } else {
        outcome = { ok: true, changedFiles: [] };
      }
      cfg.inFlight--;
      return outcome;
    },
  };
  return createEngine({
    stageRunner: runner,
    resolveTemplate: () => cfg.template,
    bus: new EventBus(),
    config: { retryCap: 2, attemptCap: 4, expansionCap: 2, maxConcurrent: cfg.maxConcurrent },
  });
}

const impls = (id: string) => listTasksByTicket(id).filter((t) => t.stageId === 'impl');
const items = (paths: string[][]): WorkItem[] =>
  paths.map((p, i) => ({ seamPaths: p, summary: `s${i}` }));

beforeAll(() => {
  runMigrations(openDb());
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'thalos-fanout-repo-'));
  insertProject({
    id: 'p',
    name: 'P',
    repoPath,
    origin: 'scratch',
    phase: 'bootstrapping',
    orchestratorProvider: 'claude',
    createdAt: 1,
  });
});

beforeEach(() => {
  cfg = {
    template: withIntegrate,
    decomp: items([['src/a'], ['src/b'], ['src/c']]),
    failLane: null,
    maxConcurrent: 4,
    inFlight: 0,
    peak: 0,
    calls: 0,
  };
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

async function start(id: string): Promise<void> {
  const engine = makeEngine();
  engine.createTicketFromTemplate({
    id,
    projectId: 'p',
    title: 'feat',
    template: cfg.template,
    mode: 'mock',
  });
  await engine.advance(id);
}

describe('dynamic fan-out', () => {
  it('materializes N isolated lanes (distinct laneId + seam) that run concurrently in WAVES', async () => {
    cfg.maxConcurrent = 2;
    await start('t1');

    const children = impls('t1');
    expect(children).toHaveLength(3);
    expect(new Set(children.map((c) => c.laneId)).size).toBe(3);
    expect(children.map((c) => c.seamPaths)).toEqual([['src/a'], ['src/b'], ['src/c']]);
    expect(children.every((c) => c.state === 'done')).toBe(true); // ticket completed → lanes done
    // throughput cap honored: at most 2 lanes ever in flight, yet all 3 ran and integrate followed.
    expect(cfg.peak).toBe(2);
    expect(getTicket('t1')?.status).toBe('done');
  });

  it('a 1-unit decomposition stays sequential (one lane)', async () => {
    cfg.decomp = items([['src/only']]);
    await start('t2');
    expect(impls('t2')).toHaveLength(1);
    expect(getTicket('t2')?.status).toBe('done');
  });

  it('PARTIAL failure escalates the ticket, retains surviving lanes, and never integrates', async () => {
    cfg.failLane = 'seam-1';
    await start('t3');

    const children = impls('t3');
    const byLane = Object.fromEntries(children.map((c) => [c.laneId, c.state]));
    expect(byLane['t3:seam-1']).toBe('escalated');
    expect(byLane['t3:seam-0']).toBe('passed'); // surviving lane retained, not torn down
    expect(byLane['t3:seam-2']).toBe('passed');
    const integrate = listTasksByTicket('t3').find((t) => t.stageId === 'integrate');
    expect(integrate?.state).toBe('pending'); // barrier never fired
    expect(getTicket('t3')?.status).toBe('escalated');
  });

  it('partial failure is ABSORBING: repeated advance() never re-dispatches/re-integrates', async () => {
    cfg.failLane = 'seam-1';
    await start('t3b');
    expect(getTicket('t3b')?.status).toBe('escalated');

    const snapshot = () =>
      listTasksByTicket('t3b')
        .map((t) => `${t.stageId}:${t.laneId}=${t.state}`)
        .sort();
    const frozenStates = snapshot();
    const callsAfterEscalation = cfg.calls;

    // Hammer advance() the way a stray WS event or boot recovery would.
    const engine = makeEngine();
    for (let i = 0; i < 5; i++) await engine.advance('t3b');

    expect(getTicket('t3b')?.status).toBe('escalated'); // stays escalated (one-way door)
    expect(cfg.calls).toBe(callsAfterEscalation); // no lane re-dispatched → no new runs/worktrees
    expect(snapshot()).toEqual(frozenStates); // no re-expansion, no auto-integration, states frozen
    expect(listTasksByTicket('t3b').find((t) => t.stageId === 'integrate')?.state).toBe('pending');
  });

  it('expansion is IDEMPOTENT — a re-advance (post-crash) makes no duplicate lanes', async () => {
    cfg.decomp = items([['src/a'], ['src/b']]);
    await start('t4');
    expect(impls('t4')).toHaveLength(2);
    const engine = makeEngine();
    await engine.advance('t4'); // simulate a redundant trigger / recovery re-advance
    expect(impls('t4')).toHaveLength(2);
    expect(getTicket('t4')?.status).toBe('done');
  });

  it('REJECTS an overlapping-seam decomposition (untrusted partition) → escalate, zero lanes', async () => {
    cfg.decomp = items([['src/a'], ['src/a/inner.ts']]);
    await start('t5');
    expect(impls('t5')).toHaveLength(0);
    expect(getTicket('t5')?.status).toBe('escalated');
  });

  it('escalates when the architect produces no valid decomposition', async () => {
    cfg.decomp = null;
    await start('t6');
    expect(impls('t6')).toHaveLength(0);
    expect(getTicket('t6')?.status).toBe('escalated');
  });

  it('BOUNDS re-expansion: request-changes past the cap escalates (meta doom-loop guard)', async () => {
    cfg.template = gatedNoIntegrate;
    cfg.decomp = items([['src/a'], ['src/b']]);
    const engine = makeEngine();
    engine.createTicketFromTemplate({
      id: 't7',
      projectId: 'p',
      title: 'feat',
      template: cfg.template,
      mode: 'mock',
    });
    await engine.advance('t7');
    expect(getTicket('t7')?.status).toBe('blocked'); // parked at plan sign-off

    // Keep asking for changes; the expansionCap (2) must eventually escalate instead of looping.
    for (let i = 0; i < 5; i++) {
      const pending = listGatesByTicket('t7').find((g) => g.status === 'pending');
      if (!pending) break;
      await engine.resolveHumanGate(pending.id, 'request-changes', 'tester');
    }
    expect(getTicket('t7')?.status).toBe('escalated');
  });
});
