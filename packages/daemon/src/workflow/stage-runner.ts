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
  ProviderId,
  Ticket,
} from '@thaloslab/shared';
import { adapterFor, routerCtx as defaultRouterCtx } from '../providers/registry';
import { type RouterCtx, resolveForInvoke } from '../providers/router';
import { getAgent } from '../store/repositories/agents';
import { getProject } from '../store/repositories/projects';
import { recentRunsForTask } from '../store/repositories/runs';
import { listTasksByTicket, updateTask } from '../store/repositories/tasks';
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
import { outOfSeam, parseDecomposition, writeDecomposition } from './decomposition';
import {
  UNIMPLEMENTED_CHECKS,
  benchmarkRegressed,
  parseBenchmark,
  runA11y,
  runSecurityScan,
} from './specialist-gates';
import {
  agentFromRole,
  clampSynthesized,
  differFor,
  mergeResolvePolicy,
  policyFor,
} from './roster/role-defaults';
import { executeRun } from './runner';
import { errorSignature } from './stuck';
import {
  type Worktree,
  abortMerge,
  aheadOfIntegration,
  auditScope,
  commitMerge,
  commitWorktree,
  createWorktree,
  detectConflicts,
  ensureIntegrationWorktree,
  mergeInto,
} from './worktree';

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
  /** Injectable for tests (fail-closed / reviewer-differs). Defaults to the live registry context. */
  routerCtx?: (projectId?: string) => RouterCtx;
}

/** The engineer's ACTUAL provider for this change — read from the run of the task(s) this one
 *  depends on — so the reviewer can be routed to a different one. */
function avoidProviderFor(ticketId: string, task: { dependsOn: string[] }): ProviderId | undefined {
  const upstream = listTasksByTicket(ticketId).filter((t) => task.dependsOn.includes(t.stageId));
  for (const u of upstream) {
    const run = recentRunsForTask(u.id).find((r) => r.provider);
    if (run?.provider) return run.provider as ProviderId;
  }
  return undefined;
}

/** AgentConfig.provider as a concrete ProviderId, or undefined for 'auto'/'collab:'. */
function preferredProvider(agent: AgentConfig): ProviderId | undefined {
  const p = agent.provider;
  return p !== 'auto' && !p.startsWith('collab:') ? (p as ProviderId) : undefined;
}

export function createProductionStageRunner(deps: StageRunnerDeps): StageRunner {
  const now = deps.now ?? (() => Date.now());
  const buildRouterCtx = deps.routerCtx ?? defaultRouterCtx;
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

  function benchmarkBaselinePath(repoPath: string, ticketId: string): string {
    return path.join(repoPath, THALOS_DIR_NAME, 'artifacts', ticketId, 'benchmark-baseline.json');
  }

  /**
   * Evaluate ONE gate check. Specialist checks run REAL implementations; an unimplemented declared
   * check (visual-diff — normally converted to a human gate at assembly) blocks LOUDLY here too, as
   * defense in depth. Deterministic checks the project doesn't declare are skipped (optional).
   */
  async function evalGateCheck(
    check: GateCheck,
    repoPath: string,
    dir: string,
    ticketId: string,
    changedFiles: string[],
    commands: ReturnType<typeof detectGateCommands>,
  ): Promise<{ ok: boolean; output: string }> {
    if (check === 'security') return runSecurityScan(dir, changedFiles);
    if (check === 'a11y') {
      const htmlFiles = changedFiles
        .filter((f) => f.endsWith('.html'))
        .map((f) => {
          try {
            return { path: f, content: fs.readFileSync(path.join(dir, f), 'utf8') };
          } catch {
            return null;
          }
        })
        .filter((x): x is { path: string; content: string } => x !== null);
      if (htmlFiles.length === 0) {
        return {
          ok: false,
          output: 'a11y: no HTML output to inspect — blocked (not silently passed)',
        };
      }
      return runA11y(htmlFiles);
    }
    if (check === 'benchmark') {
      const cmd = commands.benchmark;
      let baseline: number | null = null;
      try {
        baseline = JSON.parse(
          fs.readFileSync(benchmarkBaselinePath(repoPath, ticketId), 'utf8'),
        ).value;
      } catch {
        baseline = null;
      }
      if (!cmd || baseline === null) {
        return { ok: false, output: 'benchmark: no command or baseline — blocked' };
      }
      const res = await runCheck('benchmark', cmd, dir);
      const current = parseBenchmark(res.output);
      if (current === null) return { ok: false, output: 'benchmark: unparseable output — blocked' };
      return benchmarkRegressed(baseline, current)
        ? { ok: false, output: `benchmark regressed: baseline ${baseline} → ${current}` }
        : { ok: true, output: '' };
    }
    if (UNIMPLEMENTED_CHECKS.has(check)) {
      return { ok: false, output: `gate '${check}' has no automated implementation — blocked` };
    }
    const cmd = commands[check];
    if (!cmd) return { ok: true, output: '' }; // optional deterministic check the project omits
    const res = await runCheck(check, cmd, dir);
    return { ok: res.ok, output: res.output };
  }

  /** Run the deterministic gates (build/type/lint + unit) in a directory; first failure wins. */
  async function fullGateGreen(
    commands: ReturnType<typeof detectGateCommands>,
    dir: string,
  ): Promise<{ ok: boolean; output: string }> {
    for (const check of ['build', 'typecheck', 'lint', 'unit'] as GateCheck[]) {
      const cmd = commands[check];
      if (!cmd) continue;
      const res = await runCheck(check, cmd, dir);
      if (!res.ok) return { ok: false, output: `${check}: ${res.output.slice(0, 300)}` };
    }
    return { ok: true, output: '' };
  }

  /**
   * The real parallel integrator. Merges each lane branch into `thalos/integration` ONE AT A TIME
   * (deterministic order). On a git conflict: if the change is blast-radius it escalates immediately
   * (no agent touches sensitive merge markers); otherwise a bounded, MERGE-SCOPED resolver agent
   * fixes the markers in the integration worktree and the FULL gate must pass before the merge is
   * accepted — a resolution that breaks behavior is rejected. After all lanes merge, the full suite
   * runs once more vs the pre-integration baseline (the works-alone-breaks-together backstop).
   */
  async function runIntegration(
    ctx: StageRunContext,
    repoPath: string,
    ticket: Ticket | null,
  ): Promise<StageOutcome> {
    const { ticketId, task } = ctx;
    const mode: ExecutionMode = ticket?.mode ?? 'mock';
    const blastRadius = ticket?.blastRadius ?? [];
    const commands = detectGateCommands(repoPath);
    const integDir = await ensureIntegrationWorktree(repoPath);

    const baseline = commands.unit
      ? await runSuite(commands.unit, integDir, defaultSuiteParser)
      : undefined;

    // Merge candidates: every distinct lane branch that carries built work (is ahead of
    // integration), in deterministic order. This covers BOTH topologies — fan-out seam lanes
    // (feature/refactor) and the single :main lane (bug-fix/optimization) — and skips lanes that
    // only produced planning artifacts (the architect's :main lane is not ahead).
    const candidates = [
      ...new Set(
        listTasksByTicket(ticketId)
          .map((t) => t.branch)
          .filter((b): b is string => Boolean(b)),
      ),
    ].sort();
    const branches: string[] = [];
    for (const b of candidates) {
      if (await aheadOfIntegration(repoPath, b)) branches.push(b);
    }

    for (const branch of branches) {
      const merged = await mergeInto(integDir, branch);
      if (merged.ok) continue;

      const conflicts = await detectConflicts(integDir);
      if (blastRadius.length > 0) {
        await abortMerge(integDir);
        return {
          ok: false,
          escalate: true,
          changedFiles: branches,
          output: `blast-radius conflict (${blastRadius.join(', ')}) in ${conflicts.join(', ')} — escalated, no auto-resolve`,
        };
      }

      // True iff any conflicted file still carries git conflict markers. Checked by CONTENT, not by
      // git's unmerged status: `git add` would clear that status even with markers still present.
      const markersRemain = (): boolean =>
        conflicts.some((f) => {
          try {
            return /^(<{7}|>{7}|={7})/m.test(fs.readFileSync(path.join(integDir, f), 'utf8'));
          } catch {
            return false;
          }
        });

      // Bounded merge-scoped resolve; the FULL gate must pass before we accept the merge.
      const resolverAgent = resolveAgent(undefined, 'integrator');
      const resolverPolicy = mergeResolvePolicy(resolverAgent);
      const resolverRoute = resolveForInvoke(buildRouterCtx(ticket?.projectId), {
        policy: resolverPolicy,
        differ: 'none',
      });
      if (resolverRoute.kind === 'park') {
        await abortMerge(integDir);
        return {
          ok: false,
          escalate: true,
          changedFiles: branches,
          output: `merge-resolver routing failed closed: ${resolverRoute.reason}`,
        };
      }
      let resolved = false;
      for (let attempt = 0; attempt < 2 && !resolved; attempt++) {
        const opts: InvokeOptions = {
          prompt: `Resolve ONLY the merge conflict markers in: ${conflicts.join(', ')}. Do not rewrite logic to force a green build.`,
          systemPrompt: resolverAgent.systemPrompt,
          cwd: integDir,
          policy: resolverPolicy,
          timeoutMs: 5 * 60_000,
          mode,
        };
        await executeRun(adapterFor(resolverRoute.provider, mode), opts, {
          ticketId,
          taskId: task.id,
          agentId: undefined,
          provider: resolverRoute.provider,
          bus: deps.bus,
          now,
        });
        if (markersRemain()) continue; // resolver left markers → retry
        // Gate the resolved working tree; accept (commit) the merge ONLY if the full gate is green.
        const gate = await fullGateGreen(commands, integDir);
        if (gate.ok) {
          await commitMerge(integDir, `integrate ${branch} (conflict resolved)`);
          resolved = true;
        }
      }
      if (!resolved) {
        await abortMerge(integDir);
        return {
          ok: false,
          escalate: true,
          changedFiles: branches,
          output: `unresolved merge conflict in ${conflicts.join(', ')}`,
        };
      }
    }

    // Works-alone-breaks-together: the combined tree must build AND not regress the baseline.
    const finalGate = await fullGateGreen(commands, integDir);
    if (!finalGate.ok) {
      return {
        ok: false,
        escalate: true,
        changedFiles: branches,
        output: `integration gate failed — ${finalGate.output}`,
      };
    }
    if (commands.unit && baseline) {
      const after = await runSuite(commands.unit, integDir, defaultSuiteParser);
      const broke = newlyFailing(baseline, after);
      if (broke.length > 0) {
        return {
          ok: false,
          escalate: true,
          changedFiles: branches,
          output: `works-alone-breaks-together: combined suite regressed ${broke.join(', ')}`,
        };
      }
    }
    return { ok: true, changedFiles: branches };
  }

  return {
    async run(ctx: StageRunContext): Promise<StageOutcome> {
      const { task, template, ticketId } = ctx;
      const stage = template.stages.find((s) => s.id === task.stageId);
      const role: AgentRole = stage?.role ?? 'engineer';
      // Builders mutate code; their work must be COMMITTED to the lane branch so the integrator has
      // something to merge (worktree changes alone never reach thalos/integration).
      const isBuilder = role === 'engineer' || role === 'test-author';
      const ticket = getTicket(ticketId);
      const mode: ExecutionMode = ticket?.mode ?? 'mock';
      const repoPath = ticket
        ? (getProject(ticket.projectId)?.repoPath ?? process.cwd())
        : process.cwd();

      // The integrator doesn't get a lane worktree — it merges the lane branches into
      // thalos/integration with conflict orchestration.
      if (role === 'integrator') return runIntegration(ctx, repoPath, ticket);

      // Resolve the provider + policy BEFORE any side effect (no worktree if routing fails closed).
      // Single chokepoint: ALL invoke policy derives from the resolved agent's AgentConfig.
      const agent = resolveAgent(task.agentId, role);
      const policy = policyFor(agent);
      const differ = differFor(role);
      const resolution = resolveForInvoke(buildRouterCtx(ticket?.projectId), {
        policy,
        avoidProvider: differ !== 'none' ? avoidProviderFor(ticketId, task) : undefined,
        differ,
      });
      if (resolution.kind === 'park') {
        return {
          ok: false,
          escalate: true,
          changedFiles: [],
          output: `provider routing failed closed for ${role}: ${resolution.reason}`,
        };
      }
      const providerId = resolution.provider;

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

      const seamNote = task.seamPaths?.length
        ? `\nYour seam (only touch these paths): ${task.seamPaths.join(', ')}`
        : '';
      // A fan-out parent (architect) must emit the decomposition as a concrete artifact the engine
      // can expand from — spell out the exact filename + schema so the real agent produces it.
      const fanOutNote = stage?.fanOut
        ? `\nWrite a file named "decomposition.json" at the repo root: a JSON array where each element is {"seamPaths": ["dir-or-file", ...], "summary": "..."}. Every lane's seamPaths MUST be DISJOINT from every other lane's (no shared files/dirs). Split only along clean, independent seams; if there is no clean split, return a single element.`
        : '';
      const provider = adapterFor(providerId, mode);
      const opts: InvokeOptions = {
        prompt: `Ticket: ${ticket?.title ?? ''}\nStage: ${task.stageId} (role: ${agent.role}).${seamNote}${fanOutNote}\n${ticket?.body ?? ''}`,
        systemPrompt: agent.systemPrompt,
        cwd: wt.path,
        policy,
        timeoutMs: 5 * 60_000,
        mode,
      };
      const outcome = await executeRun(provider, opts, {
        ticketId,
        taskId: task.id,
        agentId: task.agentId,
        provider: providerId,
        requestedProvider: preferredProvider(agent),
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

      // Path OWNERSHIP audit: a fan-out child may only touch its declared seam (clean seams,
      // checked not hoped). A write outside the seam is a scope breach → escalate.
      if (task.seamPaths?.length) {
        const offending = outOfSeam(outcome.changedFiles, task.seamPaths);
        if (offending.length > 0) {
          return {
            ok: false,
            changedFiles: outcome.changedFiles,
            scopeViolation: true,
            output: `seam violation: wrote outside lane (${offending.join(', ')})`,
          };
        }
      }

      // Fan-out PARENT (architect): persist the decomposition it produced (a `decomposition.json`
      // in its worktree) to the canonical artifact path the engine expands from. Untrusted —
      // expandFanOuts re-validates + disjointness-checks before materializing any lane.
      if (stage?.fanOut) {
        let raw = '';
        try {
          raw = fs.readFileSync(path.join(wt.path, 'decomposition.json'), 'utf8');
        } catch {
          /* fall through to the parse failure below */
        }
        const items =
          parseDecomposition(raw) ?? (outcome.output ? parseDecomposition(outcome.output) : null);
        if (!items) {
          return fail(outcome, 'architect did not produce a valid decomposition.json');
        }
        writeDecomposition(repoPath, ticketId, items);
        return outcome.ok
          ? { ok: true, changedFiles: outcome.changedFiles }
          : fail(outcome, outcome.output);
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
        if (outcome.ok) await commitWorktree(wt.path, `repro @ ${task.laneId}`);
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
        if (outcome.ok) await commitWorktree(wt.path, `fix @ ${task.laneId}`);
        return outcome.ok
          ? { ok: true, changedFiles: outcome.changedFiles }
          : fail(outcome, outcome.output);
      }

      // Capture a benchmark baseline when a stage produces one (the optimization baseline stage),
      // so the later bench-gate has a real number to compare against.
      if (stage?.produces.includes('benchmark') && commands.benchmark) {
        const res = await runCheck('benchmark', commands.benchmark, wt.path);
        const value = parseBenchmark(res.output);
        if (value !== null) {
          const file = benchmarkBaselinePath(repoPath, ticketId);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, JSON.stringify({ value }), 'utf8');
        }
      }

      // --- other stages: automated gates (specialist checks run REAL implementations) ---
      const checks = template.gates
        .filter((g) => g.after === task.stageId && g.kind === 'automated')
        .flatMap((g) => g.checks ?? []);
      for (const check of checks) {
        const res = await evalGateCheck(
          check,
          repoPath,
          wt.path,
          ticketId,
          outcome.changedFiles,
          commands,
        );
        if (!res.ok) return fail(outcome, res.output);
      }
      // Commit a builder's work (e.g. a fan-out engineer) onto its lane branch for the integrator.
      if (isBuilder && outcome.ok)
        await commitWorktree(wt.path, `${task.stageId} @ ${task.laneId}`);
      return outcome.ok
        ? { ok: true, changedFiles: outcome.changedFiles }
        : fail(outcome, outcome.output);
    },
  };
}
