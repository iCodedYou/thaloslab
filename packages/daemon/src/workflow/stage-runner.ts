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
import type {
  AgentConfig,
  AgentRole,
  ExecutionMode,
  GateCheck,
  InvokeOptions,
} from '@thaloslab/shared';
import { adapterFor } from '../providers/registry';
import { getAgent } from '../store/repositories/agents';
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
import { agentFromRole, allowedToolsFor, clampSynthesized } from './roster/role-defaults';
import { executeRun } from './runner';
import { errorSignature } from './stuck';
import { type Worktree, auditScope, createWorktree } from './worktree';

interface GateState {
  baselineGreen: string[];
  reproTestIds: string[];
}

/**
 * THE invoke chokepoint: resolve a task's agent → its policy. Prefer the persisted AgentConfig
 * (assembled per ticket); fall back to role defaults for legacy/test tasks with no agentId. Always
 * re-clamp synthesized agents to least-privilege (DECISIONS #5) — defense in depth beyond assembly.
 */
function resolveAgent(agentId: string | undefined, role: AgentRole | 'custom'): AgentConfig {
  if (agentId) {
    const persisted = getAgent(agentId);
    if (persisted) return clampSynthesized(persisted);
  }
  const r: AgentRole = role === 'custom' ? 'custom' : role;
  return agentFromRole({ id: `eph-${r}`, projectId: '', role: r, name: r });
}

export interface StageRunnerDeps {
  bus: EventBus;
  now?: () => number;
}

export function createProductionStageRunner(deps: StageRunnerDeps): StageRunner {
  const now = deps.now ?? (() => Date.now());
  // One worktree per LANE — sequential stages share a lane; parallel fan-out children get distinct
  // lanes (isolated worktrees). The Map is a cache, NOT truth: createWorktree adopts-or-creates so a
  // crash that loses this Map but leaves the lane on disk recovers cleanly.
  const worktrees = new Map<string, Worktree>();

  async function ensureWorktree(repoPath: string, laneId: string): Promise<Worktree> {
    const cached = worktrees.get(laneId);
    if (cached) return cached;
    const wt = await createWorktree(repoPath, laneId);
    worktrees.set(laneId, wt);
    return wt;
  }

  function gateStatePath(repoPath: string, laneId: string): string {
    const slug = laneId.replace(/[^a-zA-Z0-9._-]/g, '-');
    return path.join(repoPath, THALOS_DIR_NAME, 'artifacts', slug, 'gate-state.json');
  }
  function writeGateState(repoPath: string, laneId: string, state: GateState): void {
    const file = gateStatePath(repoPath, laneId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state), 'utf8');
  }
  function readGateState(repoPath: string, laneId: string): GateState | null {
    try {
      return JSON.parse(fs.readFileSync(gateStatePath(repoPath, laneId), 'utf8')) as GateState;
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

      const wt = await ensureWorktree(repoPath, task.laneId);
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

      // Single chokepoint: ALL invoke policy derives from the resolved agent's AgentConfig.
      const agent = resolveAgent(task.agentId, role);
      const seamNote = task.seamPaths?.length
        ? `\nYour seam (only touch these paths): ${task.seamPaths.join(', ')}`
        : '';
      const provider = adapterFor('claude', mode);
      const opts: InvokeOptions = {
        prompt: `Ticket: ${ticket?.title ?? ''}\nStage: ${task.stageId} (role: ${agent.role}).${seamNote}\n${ticket?.body ?? ''}`,
        systemPrompt: agent.systemPrompt,
        cwd: wt.path,
        allowedTools: allowedToolsFor(agent),
        deniedCommands: agent.restrictedCommands,
        network: agent.access.network,
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
          writeGateState(repoPath, task.laneId, {
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
        const state = readGateState(repoPath, task.laneId);
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
