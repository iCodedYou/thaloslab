import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StageOutcome, StageRunner } from '../workflow/engine';

const dbFile = path.join(os.tmpdir(), `thalos-spine-${process.pid}-${Date.now()}.db`);
process.env.THALOS_DB_PATH = dbFile;

const { openDb, closeDb } = await import('../store/db');
const { runMigrations } = await import('../store/migrate');
const { insertProject } = await import('../store/repositories/projects');
const { buildApp } = await import('./app');
const { createRuntime } = await import('../workflow/runtime');

const OK: StageOutcome = { ok: true, changedFiles: [] };
const scriptedRunner: StageRunner = { run: () => Promise.resolve(OK) };

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
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
  const runtime = createRuntime({ stageRunner: scriptedRunner });
  app = buildApp({ health: { version: 't', startedAt: 0, getPort: () => 0 }, runtime });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  closeDb();
  for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
});

describe('REST spine (engine over HTTP, --mock)', () => {
  it('files a ticket, parks at the plan gate, resolves it, and reaches done', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      payload: { projectId: 'p', title: 'the export button 500s', mode: 'mock' },
    });
    expect(created.statusCode).toBe(200);
    const ticketId = (created.json() as { ticket: { id: string; taskType: string } }).ticket.id;
    expect((created.json() as { ticket: { taskType: string } }).ticket.taskType).toBe('bugfix');

    // Detail shows the task graph + a pending human gate.
    const detail = await app.inject({ method: 'GET', url: `/api/tickets/${ticketId}` });
    const body = detail.json() as {
      ticket: { status: string };
      tasks: unknown[];
      gates: { id: string; status: string }[];
    };
    expect(body.ticket.status).toBe('blocked');
    expect(body.tasks.length).toBeGreaterThan(0);
    const gate = body.gates.find((g) => g.status === 'pending');
    expect(gate).toBeDefined();

    // Resolve the gate over REST → the engine resumes and the DAG completes.
    const resolved = await app.inject({
      method: 'POST',
      url: `/api/gates/${gate!.id}/resolve`,
      payload: { decision: 'approve' },
    });
    expect(resolved.statusCode).toBe(200);

    const after = await app.inject({ method: 'GET', url: `/api/tickets/${ticketId}` });
    expect((after.json() as { ticket: { status: string } }).ticket.status).toBe('done');
  });

  it('rejects a ticket create without projectId/title', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/tickets', payload: { title: 'x' } });
    expect(res.statusCode).toBe(400);
  });
});
