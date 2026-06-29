// Full SQLite schema (SPEC §10). The entire schema is migrated up front; data-access
// repositories are built only for the tables a phase uses (DECISIONS #19 — Phase 0: projects,
// providers). One global DB across all projects (DECISIONS #14).
import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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

export const tickets = sqliteTable(
  'tickets',
  {
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
  },
  (t) => ({ statusIdx: index('tickets_status_idx').on(t.status) }),
);

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    ticketId: text('ticket_id')
      .notNull()
      .references(() => tickets.id),
    stageId: text('stage_id').notNull(),
    kind: text('kind', { enum: ['stage', 'gate'] })
      .notNull()
      .default('stage'),
    agentId: text('agent_id').references(() => agents.id),
    dependsOnJson: text('depends_on_json'),
    worktreePath: text('worktree_path'),
    branch: text('branch'),
    state: text('state').notNull(),
    retryCount: integer('retry_count').notNull().default(0),
    attempt: integer('attempt').notNull().default(0),
    lastError: text('last_error'),
    lastErrorSignature: text('last_error_signature'),
    startedAt: integer('started_at'),
    endedAt: integer('ended_at'),
    updatedAt: integer('updated_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({ ticketStateIdx: index('tasks_ticket_state_idx').on(t.ticketId, t.state) }),
);

export const runs = sqliteTable(
  'runs',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id),
    agentId: text('agent_id').references(() => agents.id),
    provider: text('provider').notNull(),
    requestedProvider: text('requested_provider'),
    prompt: text('prompt'),
    output: text('output'),
    changedFilesJson: text('changed_files_json'),
    errorSignature: text('error_signature'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    costUsd: real('cost_usd'),
    durationMs: integer('duration_ms'),
    status: text('status').notNull(),
    startedAt: integer('started_at').notNull(),
    endedAt: integer('ended_at'),
  },
  (t) => ({ taskStartedIdx: index('runs_task_started_idx').on(t.taskId, t.startedAt) }),
);

export const gates = sqliteTable('gates', {
  id: text('id').primaryKey(),
  ticketId: text('ticket_id')
    .notNull()
    .references(() => tickets.id),
  taskId: text('task_id').references(() => tasks.id),
  kind: text('kind').notNull(),
  title: text('title'),
  prompt: text('prompt'),
  checksJson: text('checks_json'),
  artifactRefId: text('artifact_ref_id'),
  status: text('status').notNull(),
  decision: text('decision', { enum: ['approve', 'reject', 'request-changes'] }),
  comment: text('comment'),
  resolvedBy: text('resolved_by'),
  resolvedAt: integer('resolved_at'),
  createdAt: integer('created_at'),
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

// Append-only audit/streaming log (commentary only — never replayed to re-execute). `seq` is a
// per-ticket monotonic counter so a reconnecting UI can fetch "everything after seq N".
export const taskEvents = sqliteTable(
  'task_events',
  {
    id: text('id').primaryKey(),
    ticketId: text('ticket_id')
      .notNull()
      .references(() => tickets.id),
    taskId: text('task_id').references(() => tasks.id),
    gateId: text('gate_id').references(() => gates.id),
    type: text('type').notNull(),
    payloadJson: text('payload_json'),
    seq: integer('seq').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({ ticketSeqIdx: index('task_events_ticket_seq_idx').on(t.ticketId, t.seq) }),
);
