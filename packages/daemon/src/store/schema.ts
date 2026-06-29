// Full SQLite schema (SPEC §10). The entire schema is migrated up front; data-access
// repositories are built only for the tables a phase uses (DECISIONS #19 — Phase 0: projects,
// providers). One global DB across all projects (DECISIONS #14).
import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  repoPath: text('repo_path').notNull(),
  githubUrl: text('github_url'),
  origin: text('origin', { enum: ['scratch', 'imported'] }).notNull(),
  phase: text('phase', { enum: ['bootstrapping', 'maintenance'] }).notNull(),
  orchestratorProvider: text('orchestrator_provider').notNull(),
  routingPolicyJson: text('routing_policy_json'),
  createdAt: integer('created_at').notNull(),
});

export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id),
  role: text('role').notNull(),
  name: text('name').notNull(),
  provider: text('provider').notNull(),
  model: text('model'),
  systemPrompt: text('system_prompt').notNull(),
  authority: text('authority').notNull(),
  accessJson: text('access_json').notNull(),
  restrictedCommandsJson: text('restricted_commands_json').notNull(),
  status: text('status', { enum: ['active', 'inactive'] }).notNull(),
  concurrency: integer('concurrency'),
  retryCap: integer('retry_cap').default(3),
  createdBy: text('created_by').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const tickets = sqliteTable('tickets', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id),
  title: text('title').notNull(),
  body: text('body'),
  taskType: text('task_type'),
  mutating: integer('mutating'),
  blastRadiusJson: text('blast_radius_json'),
  workflowId: text('workflow_id'),
  status: text('status').notNull(),
  mode: text('mode', { enum: ['preview', 'live', 'mock'] }).notNull(),
  createdAt: integer('created_at').notNull(),
});

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  ticketId: text('ticket_id')
    .notNull()
    .references(() => tickets.id),
  stageId: text('stage_id').notNull(),
  agentId: text('agent_id').references(() => agents.id),
  dependsOnJson: text('depends_on_json'),
  worktreePath: text('worktree_path'),
  branch: text('branch'),
  state: text('state').notNull(),
  retryCount: integer('retry_count').default(0),
  createdAt: integer('created_at').notNull(),
});

export const runs = sqliteTable('runs', {
  id: text('id').primaryKey(),
  taskId: text('task_id')
    .notNull()
    .references(() => tasks.id),
  agentId: text('agent_id')
    .notNull()
    .references(() => agents.id),
  provider: text('provider').notNull(),
  requestedProvider: text('requested_provider'),
  prompt: text('prompt'),
  output: text('output'),
  changedFilesJson: text('changed_files_json'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  costUsd: real('cost_usd'),
  durationMs: integer('duration_ms'),
  status: text('status').notNull(),
  startedAt: integer('started_at').notNull(),
});

export const gates = sqliteTable('gates', {
  id: text('id').primaryKey(),
  ticketId: text('ticket_id')
    .notNull()
    .references(() => tickets.id),
  taskId: text('task_id').references(() => tasks.id),
  kind: text('kind').notNull(),
  checksJson: text('checks_json'),
  status: text('status').notNull(),
  resolvedBy: text('resolved_by'),
  resolvedAt: integer('resolved_at'),
});

export const artifacts = sqliteTable('artifacts', {
  id: text('id').primaryKey(),
  ticketId: text('ticket_id')
    .notNull()
    .references(() => tickets.id),
  taskId: text('task_id').references(() => tasks.id),
  kind: text('kind').notNull(),
  path: text('path').notNull(),
  summary: text('summary'),
  createdAt: integer('created_at').notNull(),
});

export const providers = sqliteTable('providers', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  displayName: text('display_name').notNull(),
  installed: integer('installed'),
  authenticated: integer('authenticated'),
  version: text('version'),
  peerId: text('peer_id'),
  lastChecked: integer('last_checked'),
});

export const collabPeers = sqliteTable('collab_peers', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  connection: text('connection'),
  endpoint: text('endpoint'),
  sharedProvidersJson: text('shared_providers_json'),
  status: text('status').notNull(),
  joinedAt: integer('joined_at'),
});

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id),
  ticketId: text('ticket_id').references(() => tickets.id),
  type: text('type').notNull(),
  payloadJson: text('payload_json').notNull(),
  createdAt: integer('created_at').notNull(),
});
