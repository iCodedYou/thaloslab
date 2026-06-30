// Phase 6 observability acceptance bar. The LEAK TEST is teeth-by-experiment: plant secrets in BOTH
// persisted vectors (runs.prompt/output AND task_events.agent.output payloadJson) and prove they are
// ABSENT from every observability endpoint's serialized output — not that a clean run looks clean. If a
// rollup ever selects a raw-text column (or projects payloadJson), the planted canary appears and this
// fails. Plus rollup correctness, and a trust-boundary config-inspection (no CORS, loopback bind).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DAEMON_HOST } from '@thaloslab/shared';
import type { Run } from '@thaloslab/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dbFile = path.join(os.tmpdir(), `thalos-telemetry-${process.pid}-${Date.now()}.db`);
process.env.THALOS_DB_PATH = dbFile;

const { openDb, closeDb } = await import('../store/db');
const { runMigrations } = await import('../store/migrate');
const { insertProject } = await import('../store/repositories/projects');
const { insertTicket } = await import('../store/repositories/tickets');
const { insertTask } = await import('../store/repositories/tasks');
const { insertRun } = await import('../store/repositories/runs');
const { appendTaskEvent } = await import('../store/repositories/task-events');
const { safeRunsForProject, eventCountsForProject } =
  await import('../store/repositories/observability');
const { projectTelemetry, ticketTelemetry } = await import('./telemetry');

const SECRET_TOKEN = 'sk-ant-LEAKCANARY00000000000000'; // matches SECRET_PATTERNS shape
const SECRET_AWS = 'AKIALEAKCANARY000000'; // AKIA + 16
const SECRET_ENVPATH = '.env.local';

const run = (over: Partial<Run>): Run => ({
  id: 'r',
  taskId: 'task1',
  provider: 'claude',
  status: 'ok',
  startedAt: 1,
  ...over,
});

beforeAll(() => {
  runMigrations(openDb());
  insertProject({
    id: 'p',
    name: 'P',
    repoPath: '/tmp/p',
    origin: 'scratch',
    phase: 'maintenance',
    orchestratorProvider: 'claude',
    createdAt: 1,
  });
  insertTicket({
    id: 'tk',
    projectId: 'p',
    title: 'fix',
    workflowId: 'bug-fix',
    status: 'done',
    mode: 'live',
    createdAt: 1,
  });
  insertTask({
    id: 'task1',
    ticketId: 'tk',
    stageId: 'fix',
    kind: 'stage',
    laneId: 'tk:main',
    dependsOn: [],
    state: 'done',
    retryCount: 0,
    attempt: 0,
    createdAt: 1,
  });

  // Vector 1: a run whose PROMPT + OUTPUT (and changedFiles) carry secrets.
  insertRun(
    run({
      id: 'r1',
      provider: 'claude',
      prompt: `fix the bug, key is ${SECRET_TOKEN}`,
      output: `done — also ${SECRET_AWS}`,
      changedFiles: [SECRET_ENVPATH],
      status: 'ok',
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.02,
      durationMs: 1200,
      endedAt: 2,
    }),
  );
  // A second run on a collab peer provider → exercises the per-peer rollup.
  insertRun(
    run({
      id: 'r2',
      provider: 'collab:peerB:codex',
      status: 'error',
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.01,
      durationMs: 300,
      startedAt: 3,
      endedAt: 4,
    }),
  );

  // Vector 2: a persisted agent.output event whose payload carries a raw secret-bearing chunk.
  appendTaskEvent({
    id: 'ev1',
    ticketId: 'tk',
    taskId: 'task1',
    type: 'agent.output',
    payload: { runId: 'r1', event: { type: 'stdout', chunk: `leaking ${SECRET_AWS}` } },
    createdAt: 1,
  });
  appendTaskEvent({
    id: 'ev2',
    ticketId: 'tk',
    type: 'escalation',
    payload: { reason: 'doom-loop' },
    createdAt: 2,
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

describe('observability LEAK TEST — metadata only, content never crosses', () => {
  const canaries = [
    SECRET_TOKEN,
    SECRET_AWS,
    SECRET_ENVPATH,
    'sk-ant',
    'AKIA',
    'fix the bug',
    'done —',
    'leaking',
  ];

  it('the REPO projection itself never carries a raw-text column (catches a leaky SELECT, even if the rollup would discard it)', () => {
    // Closest to the source: if a future column like `prompt` is added to SAFE_RUN_COLS, the canary
    // appears HERE even though the numeric rollup would aggregate it away. This is the teeth.
    const rows = JSON.stringify(safeRunsForProject('p'));
    for (const c of canaries) expect(rows).not.toContain(c);
    expect(JSON.stringify(eventCountsForProject('p'))).not.toContain('leaking'); // count-by-type, no payload
  });

  it('project telemetry contains NONE of the planted secrets, only safe aggregates', () => {
    const t = projectTelemetry('p');
    const json = JSON.stringify(t);
    for (const c of canaries) expect(json).not.toContain(c);
    // …and it DID compute the safe rollups (so the absence is real coverage, not an empty response).
    expect(t.project.runCount).toBe(2);
    expect(t.project.inputTokens).toBe(110);
    expect(t.project.costUsd).toBeCloseTo(0.03, 5);
    expect(t.project.statusBreakdown).toEqual({ ok: 1, error: 1 });
    expect(t.escalationCount).toBe(1);
    expect(t.byProvider.map((p) => p.scopeId)).toEqual(
      expect.arrayContaining(['claude', 'collab:peerB:codex']),
    );
    expect(t.byPeer.map((p) => p.scopeId)).toEqual(['collab:peerB:codex']); // collab attribution
    expect(t.eventCounts['agent.output']).toBe(1); // the COUNT is safe; the payload never read
  });

  it('ticket telemetry contains NONE of the planted secrets, only safe aggregates', () => {
    const t = ticketTelemetry('tk');
    const json = JSON.stringify(t);
    for (const c of canaries) expect(json).not.toContain(c);
    expect(t.ticket.runCount).toBe(2);
    expect(t.escalationCount).toBe(1);
  });
});

describe('trust boundary — no widening surfaces (config inspection)', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));

  it('the daemon bind host is still loopback (127.0.0.1)', () => {
    expect(DAEMON_HOST).toBe('127.0.0.1');
  });

  it('no @fastify/cors is a dependency or registered (the no-external-origin posture holds)', () => {
    const pkg = fs.readFileSync(path.resolve(here, '../../package.json'), 'utf8');
    expect(pkg).not.toContain('@fastify/cors');
    const appSrc = fs.readFileSync(path.resolve(here, '../server/app.ts'), 'utf8');
    expect(appSrc.toLowerCase()).not.toContain('cors');
  });
});
