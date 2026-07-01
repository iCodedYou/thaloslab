// H0 — PATCH /api/projects/:id sets routingPolicy (the collab opt-in + collab targets) that FEEDS the
// fail-closed G0 dispatch gate. Proves: round-trip; malformed collab target → 400; unknown project → 404;
// and CRITICALLY default-off is preserved — a project with NO routingPolicy is collab-OFF and behaves
// exactly as today (the existing spine/e2e suites, which run local tickets on no-routingPolicy projects,
// stay green — that is the "a normal non-collab ticket is completely unaffected" proof at the suite level).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StageOutcome, StageRunner } from '../../workflow/engine';

const dbFile = path.join(os.tmpdir(), `thalos-projroutes-${process.pid}-${Date.now()}.db`);
process.env.THALOS_DB_PATH = dbFile;

const { openDb, closeDb } = await import('../../store/db');
const { runMigrations } = await import('../../store/migrate');
const { insertProject, getProject } = await import('../../store/repositories/projects');
const { projectCollabEnabled } = await import('../../workflow/collab-route');
const { buildApp } = await import('../app');
const { createRuntime } = await import('../../workflow/runtime');

const OK: StageOutcome = { ok: true, changedFiles: [] };
const scriptedRunner: StageRunner = { run: () => Promise.resolve(OK) };
let app: Awaited<ReturnType<typeof buildApp>>;

function seedProject(id: string, routingPolicy?: Record<string, unknown>): void {
  insertProject({
    id,
    name: id,
    repoPath: path.join(os.tmpdir(), `norepo-${id}`),
    origin: 'scratch',
    phase: 'maintenance',
    orchestratorProvider: 'claude',
    createdAt: 1,
    routingPolicy,
  });
}

beforeAll(async () => {
  runMigrations(openDb());
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

describe('PATCH /api/projects/:id — routing policy (collab opt-in + targets)', () => {
  it('sets collab + collabTargets and round-trips (GET reflects it; the G0 gate now reads true)', async () => {
    seedProject('p-set');
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/projects/p-set',
      payload: {
        routingPolicy: { collab: true, collabTargets: { engineer: 'collab:mac-1:codex' } },
      },
    });
    expect(res.statusCode).toBe(200);
    const rp = (res.json() as { routingPolicy: Record<string, unknown> }).routingPolicy;
    expect(rp.collab).toBe(true);
    expect((rp.collabTargets as Record<string, string>).engineer).toBe('collab:mac-1:codex');
    // Persisted + the fail-closed gate reads it as enabled.
    expect(projectCollabEnabled(getProject('p-set'))).toBe(true);
  });

  it('rejects a malformed collab target with 400 (never persists a bad id)', async () => {
    seedProject('p-bad');
    for (const bad of ['not-a-collab-id', 'collab:onlypeer', 'collab::codex', 'collab:mac-1:']) {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/projects/p-bad',
        payload: { routingPolicy: { collab: true, collabTargets: { engineer: bad } } },
      });
      expect(res.statusCode).toBe(400);
    }
    // Nothing persisted → still collab-off.
    expect(projectCollabEnabled(getProject('p-bad'))).toBe(false);
  });

  it('404 on an unknown project', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/projects/does-not-exist',
      payload: { routingPolicy: { collab: true } },
    });
    expect(res.statusCode).toBe(404);
  });

  it('DEFAULT-OFF preserved: a project with NO routingPolicy is collab-OFF and unaffected', async () => {
    seedProject('p-default'); // no routingPolicy
    expect(getProject('p-default')?.routingPolicy).toBeUndefined();
    expect(projectCollabEnabled(getProject('p-default'))).toBe(false);
    // Explicitly setting collab:false keeps it off (and carries no targets).
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/projects/p-default',
      payload: { routingPolicy: { collab: false } },
    });
    expect(res.statusCode).toBe(200);
    expect(projectCollabEnabled(getProject('p-default'))).toBe(false);
  });
});
