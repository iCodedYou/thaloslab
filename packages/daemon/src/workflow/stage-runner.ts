// Production StageRunner: composes the real moving parts the engine treats as one opaque stage —
// a per-task worktree, an agent invocation (via the registry, mode-aware), the post-run path-scope
// audit, the deterministic automated gates, and (for the reviewer role) an approve/reject verdict.
// Works in --mock (registry returns the mock adapter; gates run only if the project declares them);
// becomes live once claude.invoke() lands (step 8). Per-role prompts/allowlists are exercised live.
import fs from 'node:fs';
import type { AgentRole, ExecutionMode, InvokeOptions } from '@thaloslab/shared';
import { adapterFor } from '../providers/registry';
import { getProject } from '../store/repositories/projects';
import { updateTask } from '../store/repositories/tasks';
import { getTicket } from '../store/repositories/tickets';
import type { EventBus } from './events';
import type { StageOutcome, StageRunContext, StageRunner } from './engine';
import { detectGateCommands, runCheck } from './gates';
import { executeRun } from './runner';
import { errorSignature } from './stuck';
import { type Worktree, auditScope, createWorktree } from './worktree';

const ROLE_PROMPT: Partial<Record<AgentRole, string>> = {
  'test-author':
    'You are a test author. Write a failing test that reproduces the reported bug. Do NOT fix the bug.',
  engineer:
    'You are a senior engineer. Make the minimal correct change so the reproduction test passes. Do not touch unrelated code or leave the worktree.',
  reviewer:
    'You are an adversarial reviewer who did NOT write this code. Hunt for bugs, edge cases, and spec violations in the diff. Reply with APPROVE or REJECT and reasons.',
  integrator:
    'You are the integrator. Confirm the change integrates cleanly and the suite is green.',
};

const ROLE_ALLOWED: Partial<Record<AgentRole, string[]>> = {
  'test-author': ['Read', 'Write', 'Edit'],
  engineer: ['Read', 'Write', 'Edit', 'Bash(git *)', 'Bash(pnpm *)', 'Bash(npm *)', 'Bash(node *)'],
  reviewer: ['Read'],
  integrator: ['Read', 'Bash(git *)', 'Bash(pnpm *)', 'Bash(npm *)'],
};

const DENIED = ['Bash(rm -rf *)', 'Bash(curl *)', 'Bash(wget *)', 'WebFetch'];

export interface StageRunnerDeps {
  bus: EventBus;
  now?: () => number;
}

export function createProductionStageRunner(deps: StageRunnerDeps): StageRunner {
  const now = deps.now ?? (() => Date.now());
  const worktrees = new Map<string, Worktree>();

  async function ensureWorktree(
    repoPath: string,
    taskId: string,
    worktreePath?: string,
    branch?: string,
  ): Promise<Worktree> {
    const cached = worktrees.get(taskId);
    if (cached) return cached;
    if (worktreePath && branch && fs.existsSync(worktreePath)) {
      const wt = { taskId, path: worktreePath, branch };
      worktrees.set(taskId, wt);
      return wt;
    }
    const wt = await createWorktree(repoPath, taskId);
    updateTask(taskId, { worktreePath: wt.path, branch: wt.branch });
    worktrees.set(taskId, wt);
    return wt;
  }

  return {
    async run(ctx: StageRunContext): Promise<StageOutcome> {
      const { task, template, ticketId } = ctx;
      const stage = template.stages.find((s) => s.id === task.stageId);
      const role: AgentRole = stage?.role ?? 'engineer';
      const ticket = getTicket(ticketId);
      const mode: ExecutionMode = ticket?.mode ?? 'mock';
      const repoPath = ticket
        ? (getProject(ticket.projectId)?.repoPath ?? process.cwd())
        : process.cwd();

      const wt = await ensureWorktree(repoPath, task.id, task.worktreePath, task.branch);
      const provider = adapterFor('claude', mode);

      const opts: InvokeOptions = {
        prompt: `Ticket: ${ticket?.title ?? ''}\nStage: ${task.stageId} (role: ${role}).\n${ticket?.body ?? ''}`,
        systemPrompt: ROLE_PROMPT[role],
        cwd: wt.path,
        allowedTools: ROLE_ALLOWED[role],
        deniedCommands: DENIED,
        network: role === 'engineer' || role === 'integrator' ? 'allowlist' : 'none',
        timeoutMs: 5 * 60_000,
        mode,
      };
      const outcome = await executeRun(provider, opts, {
        ticketId,
        taskId: task.id,
        agentId: task.agentId,
        bus: deps.bus,
        now,
      });

      // Path-scope audit — the real backstop without a sandbox.
      const audit = await auditScope(repoPath);
      if (!audit.ok) {
        return {
          ok: false,
          changedFiles: outcome.changedFiles,
          scopeViolation: true,
          output: `path-scope violation: ${audit.offending.join(', ')}`,
        };
      }

      // Reviewer: the invocation's success encodes APPROVE; failure encodes REJECT (whole-loop bounce).
      if (role === 'reviewer') {
        return {
          ok: outcome.ok,
          changedFiles: outcome.changedFiles,
          reviewRejected: !outcome.ok,
          errorSignature: outcome.errorSignature,
          output: outcome.output,
        };
      }

      // Deterministic automated gates for this stage (run only those the project declares).
      const commands = detectGateCommands(repoPath);
      const checks = template.gates
        .filter((g) => g.after === task.stageId && g.kind === 'automated')
        .flatMap((g) => g.checks ?? []);
      const expectRed = task.stageId === 'repro'; // repro-red: the new test must FAIL
      for (const check of checks) {
        const cmd = commands[check];
        if (!cmd) continue; // project doesn't declare this check — skip
        const res = await runCheck(check, cmd, wt.path);
        const satisfied = expectRed ? !res.ok : res.ok;
        if (!satisfied) {
          return {
            ok: false,
            changedFiles: outcome.changedFiles,
            output: res.output.slice(0, 500),
            errorSignature: errorSignature(res.output),
          };
        }
      }

      if (!outcome.ok) {
        return {
          ok: false,
          changedFiles: outcome.changedFiles,
          output: outcome.output,
          errorSignature: outcome.errorSignature,
        };
      }
      return { ok: true, changedFiles: outcome.changedFiles };
    },
  };
}
