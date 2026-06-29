// Deterministic mirror of the --live parallel-feature smoke (the regression guard for the bug the
// live smoke surfaced): the production StageRunner + mock provider drive the feature workflow on a
// REAL git repo, and we assert the engineers' work is COMMITTED to lane branches and actually LANDS
// on thalos/integration — while the default branch is never touched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { InvokeOptions } from '@thaloslab/shared';
import { simpleGit } from 'simple-git';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MockBehavior } from '../providers/mock';

vi.setConfig({ testTimeout: 60000 });

const dbFile = path.join(os.tmpdir(), `thalos-e2e-${process.pid}-${Date.now()}.db`);
process.env.THALOS_DB_PATH = dbFile;

const { openDb, closeDb } = await import('../store/db');
const { runMigrations } = await import('../store/migrate');
const { insertProject } = await import('../store/repositories/projects');
const { upsertProvider } = await import('../store/repositories/providers');
const { getTicket } = await import('../store/repositories/tickets');
const { listGatesByTicket } = await import('../store/repositories/gates');
const { listTasksByTicket } = await import('../store/repositories/tasks');
const { createRuntime } = await import('./runtime');
const { intakeTicket } = await import('./orchestrator/intake');
const { setMockProgram, resetMock } = await import('../providers/mock');

let repo: string;
let mainHeadBefore: string;

beforeAll(async () => {
  runMigrations(openDb());
  upsertProvider({
    id: 'claude',
    kind: 'local',
    displayName: 'Claude',
    installed: true,
    authenticated: true,
    lastChecked: 1,
  });
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'thalos-e2e-repo-'));
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
        test: 'node test.mjs',
        build: 'node -e ""',
        typecheck: 'node -e ""',
        lint: 'node -e ""',
      },
    }),
  );
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'a.mjs'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(repo, 'src', 'b.mjs'), 'export const b = 1;\n');
  fs.writeFileSync(
    path.join(repo, 'test.mjs'),
    "import {a} from './src/a.mjs'; import {b} from './src/b.mjs'; if(typeof a!=='number'||typeof b!=='number'){console.log('FAIL'); process.exit(1)} console.log('PASS a'); console.log('PASS b');\n",
  );
  await git.add('.');
  await git.commit('init');
  mainHeadBefore = (await git.revparse(['main'])).trim();

  insertProject({
    id: 'p',
    name: 'P',
    repoPath: repo,
    origin: 'scratch',
    phase: 'maintenance',
    orchestratorProvider: 'claude',
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

describe('end-to-end feature: parallel lanes land on thalos/integration', () => {
  it('architect decomposes → engineers build in isolated lanes → integrator lands the work', async () => {
    setMockProgram((opts: InvokeOptions): MockBehavior => {
      if (opts.prompt.includes('Stage: plan')) {
        return {
          ok: true,
          writeFiles: {
            'decomposition.json': JSON.stringify([
              { seamPaths: ['src/a.mjs'], summary: 'feature A' },
              { seamPaths: ['src/b.mjs'], summary: 'feature B' },
            ]),
          },
        };
      }
      if (opts.prompt.includes('src/a.mjs')) {
        return { ok: true, writeFiles: { 'src/a.mjs': 'export const a = 42; // feature A\n' } };
      }
      if (opts.prompt.includes('src/b.mjs')) {
        return { ok: true, writeFiles: { 'src/b.mjs': 'export const b = 99; // feature B\n' } };
      }
      return { ok: true };
    });

    const runtime = createRuntime();
    const ticket = await intakeTicket(runtime.engine, {
      projectId: 'p',
      title: 'Add a feature across two modules',
      body: 'add features',
      mode: 'mock',
    });
    const id = ticket.id;

    for (let i = 0; i < 8; i++) {
      const t = getTicket(id);
      if (!t || ['done', 'failed', 'escalated', 'aborted'].includes(t.status)) break;
      if (t.status === 'blocked') {
        const gate = listGatesByTicket(id).find((g) => g.status === 'pending');
        if (!gate) break;
        await runtime.engine.resolveHumanGate(gate.id, 'approve', 'test');
      } else {
        await runtime.engine.advance(id);
      }
    }

    expect(getTicket(id)?.status).toBe('done');

    // Two isolated impl lanes materialized.
    const impls = listTasksByTicket(id).filter((t) => t.stageId === 'impl');
    expect(new Set(impls.map((t) => t.laneId)).size).toBe(2);

    // The engineers' work actually LANDED on thalos/integration (not just in the worktrees).
    const git = simpleGit(repo);
    const onIntegrationA = await git.show(['thalos/integration:src/a.mjs']);
    const onIntegrationB = await git.show(['thalos/integration:src/b.mjs']);
    expect(onIntegrationA).toContain('feature A');
    expect(onIntegrationB).toContain('feature B');

    // The default branch was never touched.
    expect((await git.revparse(['main'])).trim()).toBe(mainHeadBefore);
  });
});
