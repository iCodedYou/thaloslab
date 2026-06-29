// Data access for `agents` (Phase 2). Agent configs are the runtime roster; they also mirror to
// `.thalos/agents/*.json` (git-tracked, human-editable; the DB is the queryable index) per SPEC §6.
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import {
  type AccessLevel,
  type AgentConfig,
  type AgentCreatedBy,
  type AgentRole,
  type AgentStatus,
  type AuthorityLevel,
  THALOS_AGENTS_DIR,
  THALOS_DIR_NAME,
} from '@thaloslab/shared';
import { getDb } from '../db';
import { agents } from '../schema';

type Row = typeof agents.$inferSelect;

function toAgent(row: Row): AgentConfig {
  return {
    id: row.id,
    projectId: row.projectId,
    role: row.role as AgentRole,
    name: row.name,
    provider: row.provider as AgentConfig['provider'],
    model: row.model ?? undefined,
    systemPrompt: row.systemPrompt,
    authority: row.authority as AuthorityLevel,
    access: JSON.parse(row.accessJson) as AccessLevel,
    restrictedCommands: JSON.parse(row.restrictedCommandsJson) as string[],
    status: row.status as AgentStatus,
    concurrency: row.concurrency ?? undefined,
    retryCap: row.retryCap ?? undefined,
    createdBy: row.createdBy as AgentCreatedBy,
  };
}

function values(a: AgentConfig) {
  return {
    id: a.id,
    projectId: a.projectId,
    role: a.role,
    name: a.name,
    provider: a.provider,
    model: a.model ?? null,
    systemPrompt: a.systemPrompt,
    authority: a.authority,
    accessJson: JSON.stringify(a.access),
    restrictedCommandsJson: JSON.stringify(a.restrictedCommands),
    status: a.status,
    concurrency: a.concurrency ?? null,
    retryCap: a.retryCap ?? null,
    createdBy: a.createdBy,
  };
}

export function upsertAgent(a: AgentConfig, now = Date.now()): AgentConfig {
  const v = values(a);
  getDb()
    .insert(agents)
    .values({ ...v, createdAt: now })
    .onConflictDoUpdate({ target: agents.id, set: v })
    .run();
  return a;
}

export function getAgent(id: string): AgentConfig | null {
  const row = getDb().select().from(agents).where(eq(agents.id, id)).get();
  return row ? toAgent(row) : null;
}

export function listAgentsByProject(projectId: string): AgentConfig[] {
  return getDb().select().from(agents).where(eq(agents.projectId, projectId)).all().map(toAgent);
}

// ---- `.thalos/agents/*.json` mirror (git-tracked, versioned per SPEC §6) ----

function agentsDir(repoPath: string): string {
  return path.join(repoPath, THALOS_DIR_NAME, THALOS_AGENTS_DIR);
}

export function writeAgentFile(repoPath: string, a: AgentConfig): void {
  const dir = agentsDir(repoPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${a.id}.json`),
    `${JSON.stringify({ version: 1, ...a }, null, 2)}\n`,
    'utf8',
  );
}

export function readAgentFiles(repoPath: string): AgentConfig[] {
  const dir = agentsDir(repoPath);
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: AgentConfig[] = [];
  for (const f of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as AgentConfig;
      out.push(parsed);
    } catch {
      // skip malformed file
    }
  }
  return out;
}
