import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Point the store at a throwaway temp DB BEFORE opening it.
const dbFile = path.join(os.tmpdir(), `thalos-repo-test-${process.pid}-${Date.now()}.db`);
process.env.THALOS_DB_PATH = dbFile;

const { openDb, closeDb } = await import('../db');
const { runMigrations } = await import('../migrate');
const { insertProject } = await import('./projects');
const { insertTicket, getTicket, setTicketStatus, updateTicketTriage } = await import('./tickets');
const { insertTask, claimTaskState, getTask, listTasksByTicket } = await import('./tasks');
const { insertRun, updateRun, recentRunsForTask, interruptRunningRuns } = await import('./runs');
const { insertGate, resolveGate, getGate } = await import('./gates');
const { appendTaskEvent, eventsSince } = await import('./task-events');

beforeAll(() => {
  runMigrations(openDb());
  insertProject({
    id: 'proj1',
    name: 'T',
    repoPath: '/tmp/t',
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

describe('repositories round-trip', () => {
  it('tickets: insert/read/triage/status', () => {
    insertTicket({
      id: 't1',
      projectId: 'proj1',
      title: 'export 500s',
      status: 'queued',
      mode: 'mock',
      createdAt: 2,
    });
    updateTicketTriage('t1', { taskType: 'bugfix', mutating: true, blastRadius: ['data'] });
    setTicketStatus('t1', 'running');
    const t = getTicket('t1');
    expect(t?.taskType).toBe('bugfix');
    expect(t?.mutating).toBe(true);
    expect(t?.blastRadius).toEqual(['data']);
    expect(t?.status).toBe('running');
  });

  it('tasks: insert + dependsOn round-trip + atomic single-flight claim', () => {
    insertTask({
      id: 'task1',
      ticketId: 't1',
      stageId: 'fix',
      kind: 'stage',
      dependsOn: ['repro'],
      state: 'pending',
      retryCount: 0,
      attempt: 0,
      createdAt: 3,
    });
    expect(getTask('task1')?.dependsOn).toEqual(['repro']);
    expect(listTasksByTicket('t1')).toHaveLength(1);

    // Two concurrent claimants: exactly one wins.
    const first = claimTaskState('task1', 'pending', 'running');
    const second = claimTaskState('task1', 'pending', 'running');
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(getTask('task1')?.state).toBe('running');
  });

  it('runs: insert/update + recent + interrupt reaping', () => {
    insertRun({ id: 'r1', taskId: 'task1', provider: 'mock', status: 'running', startedAt: 10 });
    updateRun('r1', {
      status: 'error',
      errorSignature: 'sig-abc',
      changedFiles: ['a.ts'],
      endedAt: 11,
    });
    const recent = recentRunsForTask('task1');
    expect(recent[0]?.errorSignature).toBe('sig-abc');
    expect(recent[0]?.changedFiles).toEqual(['a.ts']);

    insertRun({ id: 'r2', taskId: 'task1', provider: 'mock', status: 'running', startedAt: 20 });
    const reaped = interruptRunningRuns(99);
    expect(reaped).toContain('r2');
    expect(recentRunsForTask('task1').find((r) => r.id === 'r2')?.status).toBe('interrupted');
  });

  it('gates: human gate resolves once (single-flight)', () => {
    insertGate({
      id: 'g1',
      ticketId: 't1',
      taskId: 'task1',
      kind: 'human',
      title: 'Plan sign-off',
      status: 'pending',
    });
    expect(resolveGate('g1', 'approve', 'user', 'looks good')).toBe(true);
    expect(resolveGate('g1', 'reject', 'user')).toBe(false); // already resolved
    const g = getGate('g1');
    expect(g?.status).toBe('resolved');
    expect(g?.decision).toBe('approve');
    expect(g?.comment).toBe('looks good');
  });

  it('task_events: per-ticket monotonic seq + gap fetch', () => {
    const e1 = appendTaskEvent({ id: 'e1', ticketId: 't1', type: 'task.state', createdAt: 1 });
    const e2 = appendTaskEvent({
      id: 'e2',
      ticketId: 't1',
      type: 'stage-update',
      payload: { stageId: 'fix' },
      createdAt: 2,
    });
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    const since = eventsSince('t1', 1);
    expect(since).toHaveLength(1);
    expect(since[0]?.id).toBe('e2');
    expect(since[0]?.payload).toEqual({ stageId: 'fix' });
  });
});
