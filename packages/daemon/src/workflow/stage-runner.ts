// Production StageRunner: composes the real moving parts the engine treats as one opaque stage —
// a worktree, an agent invocation (via the registry, mode-aware), the post-run path-scope audit,
// the deterministic automated gates, and (for the reviewer) an approve/reject verdict. The bug-fix
// stages are SEQUENTIAL on one change, so they share ONE worktree per ticket — that is what lets
// the reproduction test the test-author writes reach the engineer's fix stage. Gates are PRECISE:
// repro-red asserts a NEW reproduction test now fails; the fix gate asserts that specific test
// passes AND nothing previously-green regressed (suite-level exit code can't see either).
import fs from 'node:fs';
import path from 'node:path';
import { THALOS_DIR_NAME } from '@thaloslab/shared';
import type { AgentRole, ExecutionMode, GateCheck, InvokeOptions } from '@thaloslab/shared';
import { adapterFor } from '../providers/registry';
import { getProject } from '../store/repositories/projects';
import { updateTask } from '../store/repositories/tasks';
import { getTicket } from '../store/repositories/tickets';
import type { EventBus } from './events';
import type { StageOutcome, StageRunContext, StageRunner } from './engine';
import {
  type SuiteResult,
  defaultSuiteParser,
  detectGateCommands,
  fixSatisfiedAll,
  newlyFailing,
  runCheck,
  runSuite,
} from './gates';
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

interface GateState {
  baselineGreen: string[];
  reproTestIds: string[];
}

export interface StageRunnerDeps {
  bus: EventBus;
  now?: () => number;
}

export function createProductionStageRunner(deps: StageRunnerDeps): StageRunner {
  const now = deps.now ?? (() => Date.now());
  // One worktree per TICKET — sequential bug-fix stages build on the same change.
  const worktrees = new Map<string, Worktree>();

  async function ensureWorktree(repoPath: string, ticketId: string): Promise<Worktree> {
    const cached = worktrees.get(ticketId);
    if (cached) return cached;
    const wt = await createWorktree(repoPath, ticketId);
    worktrees.set(ticketId, wt);
    return wt;
  }

  function gateStatePath(repoPath: string, ticketId: string): string {
    return path.join(repoPath, THALOS_DIR_NAME, 'artifacts', ticketId, 'gate-state.json');
  }
  function writeGateState(repoPath: string, ticketId: string, state: GateState): void {
    const file = gateStatePath(repoPath, ticketId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state), 'utf8');
  }
  function readGateState(repoPath: string, ticketId: string): GateState | null {
    try {
      return JSON.parse(fs.readFileSync(gateStatePath(repoPath, ticketId), 'utf8')) as GateState;
    } catch {
      return null;
    }
  }

  function fail(outcome: { changedFiles: string[] }, reason: string): StageOutcome {
    return {
      ok: false,
      changedFiles: outcome.changedFiles,
      output: reason.slice(0, 500),
      errorSignature: errorSignature(reason),
    };
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

      const wt = await ensureWorktree(repoPath, ticketId);
      if (task.worktreePath !== wt.path) {
        updateTask(task.id, { worktreePath: wt.path, branch: wt.branch });
      }
      const commands = detectGateCommands(repoPath);
      const unitCmd = commands.unit;

      // Capture the suite baseline BEFORE the repro stage's agent runs, so we can identify the
      // reproduction test it adds (the tests that newly fail).
      let baseline: SuiteResult | undefined;
      if (task.stageId === 'repro' && unitCmd) {
        baseline = await runSuite(unitCmd, wt.path, defaultSuiteParser);
      }

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

      // --- repro-red gate: the SPECIFIC new reproduction test must fail (not just suite-red) ---
      if (task.stageId === 'repro') {
        if (unitCmd && baseline) {
          const after = await runSuite(unitCmd, wt.path, defaultSuiteParser);
          const reproTestIds = newlyFailing(baseline, after);
          if (reproTestIds.length === 0) {
            return fail(outcome, 'repro-red: no new failing reproduction test was added');
          }
          writeGateState(repoPath, ticketId, {
            baselineGreen: baseline.cases.filter((c) => c.passed).map((c) => c.id),
            reproTestIds,
          });
        }
        return outcome.ok
          ? { ok: true, changedFiles: outcome.changedFiles }
          : fail(outcome, outcome.output);
      }

      // --- fix gate: the repro test now PASSES and nothing previously-green regressed ---
      if (task.stageId === 'fix') {
        for (const check of ['build', 'typecheck', 'lint'] as GateCheck[]) {
          const cmd = commands[check];
          if (!cmd) continue;
          const res = await runCheck(check, cmd, wt.path);
          if (!res.ok) return fail(outcome, res.output);
        }
        const state = readGateState(repoPath, ticketId);
        if (unitCmd && state) {
          const current = await runSuite(unitCmd, wt.path, defaultSuiteParser);
          const verdict = fixSatisfiedAll(state.baselineGreen, state.reproTestIds, current);
          if (!verdict.ok) return fail(outcome, verdict.reason ?? 'fix gate not satisfied');
        } else if (unitCmd) {
          // No persisted repro state (e.g. recovery) — fall back to suite-green.
          const res = await runCheck('unit', unitCmd, wt.path);
          if (!res.ok) return fail(outcome, res.output);
        }
        return outcome.ok
          ? { ok: true, changedFiles: outcome.changedFiles }
          : fail(outcome, outcome.output);
      }

      // --- other stages (regression, integrate, …): coarse exit-code gates ---
      const checks = template.gates
        .filter((g) => g.after === task.stageId && g.kind === 'automated')
        .flatMap((g) => g.checks ?? []);
      for (const check of checks) {
        const cmd = commands[check];
        if (!cmd) continue;
        const res = await runCheck(check, cmd, wt.path);
        if (!res.ok) return fail(outcome, res.output);
      }
      return outcome.ok
        ? { ok: true, changedFiles: outcome.changedFiles }
        : fail(outcome, outcome.output);
    },
  };
}
