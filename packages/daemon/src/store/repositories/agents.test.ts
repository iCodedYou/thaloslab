import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentConfig } from '@thaloslab/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dbFile = path.join(os.tmpdir(), `thalos-agents-${process.pid}-${Date.now()}.db`);
process.env.THALOS_DB_PATH = dbFile;

const { openDb, closeDb } = await import('../db');
const { runMigrations } = await import('../migrate');
const { insertProject } = await import('./projects');
const repo = await import('./agents');

function agent(over: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'ag-p-engineer',
    projectId: 'p',
    role: 'engineer',
    name: 'Engineer',
    provider: 'claude',
    systemPrompt: 'build it',
    authority: 'L2-execute-gated',
    access: { pathScope: 'own-worktree', network: 'allowlist' },
    restrictedCommands: ['Bash(rm -rf *)'],
    status: 'active',
    createdBy: 'default',
    ...over,
  };
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

describe('agents repository', () => {
  it('upserts and reads back an agent with JSON fields intact', () => {
    repo.upsertAgent(agent());
    const got = repo.getAgent('ag-p-engineer');
    expect(got).toMatchObject({
      role: 'engineer',
      authority: 'L2-execute-gated',
      access: { pathScope: 'own-worktree', network: 'allowlist' },
      restrictedCommands: ['Bash(rm -rf *)'],
    });
  });

  it('upsert is idempotent by id (re-assembly updates, does not duplicate)', () => {
    repo.upsertAgent(agent({ name: 'Engineer' }));
    repo.upsertAgent(agent({ name: 'Engineer (renamed)' }));
    const all = repo.listAgentsByProject('p');
    expect(all).toHaveLength(1);
    expect(all[0]?.name).toBe('Engineer (renamed)');
  });

  it('mirrors to .thalos/agents/*.json and reads them back', () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'thalos-agentsdir-'));
    try {
      repo.writeAgentFile(repoPath, agent({ id: 'ag-p-reviewer', role: 'reviewer' }));
      const files = repo.readAgentFiles(repoPath);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({ id: 'ag-p-reviewer', role: 'reviewer' });
      expect(fs.existsSync(path.join(repoPath, '.thalos', 'agents', 'ag-p-reviewer.json'))).toBe(
        true,
      );
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });
});
