// The workflow engine (load-bearing). Public API: createTicketFromTemplate, advance(ticketId),
// resolveHumanGate, abort. Design (DECISIONS + plan):
//   - current-state rows are the truth; advance() is the single idempotent mover.
//   - advance() is serialized PER TICKET (async lock) and the ready→running transition is an
//     atomic single-flight claim, so concurrent triggers can't double-dispatch / double-worktree.
//   - the build loop bounds itself with TWO independent caps: per-gate-loop retryCap and
//     whole-loop attemptCap (review bounce-backs) — both escalate.
//   - human gates durably park (no busy-wait) and resume via resolveHumanGate → advance.
//   - preview never strands: it renders the plan/DAG and stops in terminal `preview-complete`.
import type {
  ExecutionMode,
  GateDecision,
  Task,
  TaskState,
  Ticket,
  WorkflowTemplate,
} from '@thaloslab/shared';
import { getGate, insertGate, resolveGate } from '../store/repositories/gates';
import { insertMessage } from '../store/repositories/messages';
import { recentRunsForTask } from '../store/repositories/runs';
import {
  type TaskPatch,
  claimTaskState,
  getTask,
  insertTask,
  listTasksByTicket,
  updateTask,
} from '../store/repositories/tasks';
import { getTicket, insertTicket, setTicketStatus } from '../store/repositories/tickets';
import { genId } from '../util/id';
import type { EventBus } from './events';
import { capabilitiesFor } from './mode';
import { readyTasks } from './scheduler';
import { type TaskEventName, isFinal, nextState } from './state-machine';
import { detectDoomLoop } from './stuck';

export interface StageOutcome {
  ok: boolean;
  changedFiles: string[];
  /** Human-readable failure detail (gate output / error), surfaced in escalations. */
  output?: string;
  errorSignature?: string;
  /** Adversarial reviewer rejected → a whole-loop bounce (attempt++), even if gates were green. */
  reviewRejected?: boolean;
  /** Post-run path-scope audit failed → immediate escalation. */
  scopeViolation?: boolean;
}

export interface StageRunContext {
  ticketId: string;
  task: Task;
  template: WorkflowTemplate;
}

/** Executes one LLM stage (invoke + automated gates + optional reviewer) → an outcome. Injected
 *  so the engine is testable with a scripted runner; production composes invoke + GateRunner. */
export interface StageRunner {
  run(ctx: StageRunContext): Promise<StageOutcome>;
}

export interface EngineDeps {
  stageRunner: StageRunner;
  resolveTemplate: (ticket: Ticket) => WorkflowTemplate;
  bus: EventBus;
  config?: { retryCap?: number; attemptCap?: number };
  now?: () => number;
}

export interface CreateTicketInput {
  id?: string;
  projectId: string;
  title: string;
  body?: string;
  template: WorkflowTemplate;
  mode: ExecutionMode;
}

const HUMAN_GATE_KIND = 'human';

export function createEngine(deps: EngineDeps) {
  const now = deps.now ?? (() => Date.now());
  const retryCap = deps.config?.retryCap ?? 3;
  const attemptCap = deps.config?.attemptCap ?? 6;

  // Per-ticket serialization: advance() calls for the same ticket queue behind each other.
  const locks = new Map<string, Promise<unknown>>();
  function withTicketLock<T>(ticketId: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(ticketId) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    locks.set(
      ticketId,
      run.catch(() => undefined),
    );
    return run;
  }

  function stageById(template: WorkflowTemplate, stageId: string) {
    return template.stages.find((s) => s.id === stageId);
  }
  function gateById(template: WorkflowTemplate, gateId: string) {
    return template.gates.find((g) => g.id === gateId);
  }

  /** Validate + persist a task transition, emitting a task.state event. */
  function applyEvent(task: Task, event: TaskEventName, patch: TaskPatch = {}): Task {
    const to: TaskState = nextState(task.state, event);
    updateTask(task.id, { ...patch, state: to });
    const updated = getTask(task.id);
    deps.bus.emit({
      ticketId: task.ticketId,
      taskId: task.id,
      type: 'task.state',
      payload: { state: to, event },
    });
    return updated ?? { ...task, state: to };
  }

  function isHumanGateTask(task: Task, template: WorkflowTemplate): boolean {
    return task.kind === 'gate' && gateById(template, task.stageId)?.kind === HUMAN_GATE_KIND;
  }

  // ---- ticket creation ----

  function createTicketFromTemplate(input: CreateTicketInput): Ticket {
    const ticketId = input.id ?? genId('tk');
    const ticket: Ticket = {
      id: ticketId,
      projectId: input.projectId,
      title: input.title,
      body: input.body,
      workflowId: input.template.id,
      status: 'queued',
      mode: input.mode,
      createdAt: now(),
    };
    insertTicket(ticket);

    // Materialize the task graph: one task per stage + one per HUMAN gate (parking node).
    for (const stage of input.template.stages) {
      insertTask({
        id: genId('tsk'),
        ticketId,
        stageId: stage.id,
        kind: 'stage',
        dependsOn: stage.dependsOn,
        state: 'pending',
        retryCount: 0,
        attempt: 0,
        createdAt: now(),
      });
    }
    for (const gate of input.template.gates) {
      if (gate.kind === HUMAN_GATE_KIND) {
        insertTask({
          id: genId('tsk'),
          ticketId,
          stageId: gate.id,
          kind: 'gate',
          // A gate with an empty `after` gates the whole plan (no upstream dep → ready immediately).
          dependsOn: gate.after ? [gate.after] : [],
          state: 'pending',
          retryCount: 0,
          attempt: 0,
          createdAt: now(),
        });
      }
    }

    deps.bus.emit({
      ticketId,
      type: 'plan-of-attack',
      payload: { workflow: input.template.label, stages: input.template.stages.map((s) => s.id) },
    });
    insertMessage({
      id: genId('msg'),
      projectId: input.projectId,
      ticketId,
      message: {
        type: 'plan-of-attack',
        workflow: input.template.label,
        roster: input.template.stages.map((s) => s.role),
        rationale: `Bug-fix workflow with ${input.template.stages.length} stages.`,
      },
      createdAt: now(),
    });

    const caps = capabilitiesFor(input.mode);
    if (!caps.invokeAgents) {
      // Preview: render the plan + DAG and STOP (terminal) — never park at an unresolvable gate.
      setTicketStatus(ticketId, 'preview-complete');
      insertMessage({
        id: genId('msg'),
        projectId: input.projectId,
        ticketId,
        message: {
          type: 'text',
          from: 'orchestrator',
          content: 'Preview only — relaunch in --live to execute this plan.',
        },
        createdAt: now(),
      });
    }
    return getTicket(ticketId) ?? ticket;
  }

  // ---- the mover ----

  async function advance(ticketId: string): Promise<void> {
    await withTicketLock(ticketId, () => advanceInner(ticketId));
  }

  async function advanceInner(ticketId: string): Promise<void> {
    const ticket = getTicket(ticketId);
    if (!ticket) return;
    const caps = capabilitiesFor(ticket.mode);
    if (!caps.invokeAgents) return; // preview never executes
    const template = deps.resolveTemplate(ticket);

    setTicketStatus(ticketId, 'running');

    // Keep dispatching ready tasks until none remain claimable this tick.
    for (;;) {
      const tasks = listTasksByTicket(ticketId);
      const ready = readyTasks(tasks);
      if (ready.length === 0) break;

      // Atomic single-flight claim: only the caller that flips pending→running dispatches.
      const claimed = ready.filter((t) =>
        claimTaskState(t.id, 'pending', 'running', { startedAt: now() }),
      );
      if (claimed.length === 0) break;

      await Promise.all(claimed.map((t) => runTask(ticketId, t.id, template)));
    }

    reconcileTicket(ticketId, template);
  }

  async function runTask(
    ticketId: string,
    taskId: string,
    template: WorkflowTemplate,
  ): Promise<void> {
    let task = getTask(taskId);
    if (!task) return;

    if (isHumanGateTask(task, template)) {
      parkHumanGate(ticketId, task, template);
      return;
    }

    const stage = stageById(template, task.stageId);
    const stageRetryCap = stage?.loop?.retryCap ?? retryCap;

    // Build loop: execute → on success pass; on failure bump the right counter, check doom, retry.
    for (;;) {
      task = getTask(taskId);
      if (!task || isFinal(task.state)) return;
      const outcome = await deps.stageRunner.run({ ticketId, task, template });
      task = getTask(taskId) ?? task;

      if (outcome.scopeViolation) {
        escalateTask(task, 'path-scope violation: agent wrote outside its worktree');
        return;
      }
      if (outcome.ok && !outcome.reviewRejected) {
        applyEvent(task, 'to-passed', { endedAt: now() });
        return;
      }

      // Failure path — bump the appropriate independent counter.
      if (outcome.reviewRejected) {
        task = applyEvent(task, 'to-review');
        task = applyEvent(task, 'review-rejected', {
          attempt: task.attempt + 1,
          lastError: 'adversarial reviewer rejected the change',
          lastErrorSignature: outcome.errorSignature ?? null,
        });
      } else {
        task = applyEvent(task, 'gates-failed', {
          retryCount: task.retryCount + 1,
          lastError: (outcome.output ?? 'gate failed').slice(0, 500),
          lastErrorSignature: outcome.errorSignature ?? null,
        });
      }

      const fresh = getTask(taskId) ?? task;
      const verdict = detectDoomLoop(fresh, recentRunsForTask(taskId), {
        retryCap: stageRetryCap,
        attemptCap,
      });
      if (verdict.stuck) {
        escalateTask(fresh, `doom-loop: ${verdict.reason}`);
        return;
      }
      applyEvent(fresh, 'retry'); // fixing → running, loop again
    }
  }

  function escalateTask(task: Task, reason: string): void {
    applyEvent(task, 'escalate', { lastError: reason, endedAt: now() });
    deps.bus.emit({
      ticketId: task.ticketId,
      taskId: task.id,
      type: 'escalation',
      payload: { reason },
    });
    const ticket = getTicket(task.ticketId);
    if (ticket) {
      insertMessage({
        id: genId('msg'),
        projectId: ticket.projectId,
        ticketId: ticket.id,
        message: { type: 'escalation', reason, options: ['retry', 'abort', 'adjust'] },
        createdAt: now(),
      });
    }
  }

  function parkHumanGate(ticketId: string, task: Task, template: WorkflowTemplate): void {
    const gateDef = gateById(template, task.stageId);
    const gateId = genId('gate');
    const title = gateDef?.prompt ?? 'Approval required';
    insertGate({
      id: gateId,
      ticketId,
      taskId: task.id,
      kind: 'human',
      title,
      prompt: gateDef?.prompt,
      status: 'pending',
      createdAt: now(),
    });
    applyEvent(task, 'block-human');
    setTicketStatus(ticketId, 'blocked');
    deps.bus.emit({ ticketId, taskId: task.id, gateId, type: 'gate.pending', payload: { title } });
    const ticket = getTicket(ticketId);
    if (ticket) {
      insertMessage({
        id: genId('msg'),
        projectId: ticket.projectId,
        ticketId,
        message: {
          type: 'approval-gate',
          gateId,
          title,
          artifactRef: { id: gateId, kind: 'plan', path: `gates/${gateId}` },
          options: ['approve', 'request-changes', 'reject'],
        },
        createdAt: now(),
      });
    }
  }

  // ---- human gate resolution ----

  async function resolveHumanGate(
    gateId: string,
    decision: GateDecision,
    resolvedBy: string,
    comment?: string,
  ): Promise<void> {
    const gate = getGate(gateId);
    if (!gate || !gate.taskId) return;
    if (!resolveGate(gateId, decision, resolvedBy, comment)) return; // lost the single-flight race
    const ticketId = gate.ticketId;
    const taskId = gate.taskId;

    await withTicketLock(ticketId, () => {
      const task = getTask(taskId);
      if (!task) return Promise.resolve();
      if (decision === 'approve') {
        applyEvent(task, 'human-approved', { endedAt: now() });
      } else if (decision === 'reject') {
        applyEvent(task, 'human-rejected', { endedAt: now() });
        setTicketStatus(ticketId, 'failed');
      } else {
        // request-changes: re-run the upstream stage(s) and re-arm this gate node.
        for (const depStageId of task.dependsOn) {
          const depTask = listTasksByTicket(ticketId).find((t) => t.stageId === depStageId);
          if (depTask) updateTask(depTask.id, { state: 'pending', retryCount: 0, attempt: 0 });
        }
        updateTask(taskId, { state: 'pending' }); // gate re-arm (gate node, not a stage)
      }
      return Promise.resolve();
    });

    if (decision !== 'reject') await advance(ticketId);
  }

  // ---- ticket reconciliation ----

  function reconcileTicket(ticketId: string, _template: WorkflowTemplate): void {
    const tasks = listTasksByTicket(ticketId);
    if (tasks.some((t) => t.state === 'escalated')) {
      setTicketStatus(ticketId, 'escalated');
      return;
    }
    if (tasks.some((t) => t.state === 'failed')) {
      setTicketStatus(ticketId, 'failed');
      return;
    }
    if (tasks.some((t) => t.state === 'blocked-on-human')) {
      setTicketStatus(ticketId, 'blocked');
      return;
    }
    if (tasks.every((t) => t.state === 'passed' || t.state === 'done')) {
      for (const t of tasks) if (t.state === 'passed') applyEvent(t, 'complete');
      setTicketStatus(ticketId, 'done');
      const ticket = getTicket(ticketId);
      if (ticket) {
        insertMessage({
          id: genId('msg'),
          projectId: ticket.projectId,
          ticketId,
          message: { type: 'done', ticketId, summary: 'Workflow complete.', artifactRefs: [] },
          createdAt: now(),
        });
        deps.bus.emit({ ticketId, type: 'done', payload: {} });
      }
      return;
    }
    setTicketStatus(ticketId, 'running');
  }

  function abort(ticketId: string): void {
    for (const t of listTasksByTicket(ticketId)) {
      if (!isFinal(t.state)) updateTask(t.id, { state: 'failed', endedAt: now() });
    }
    setTicketStatus(ticketId, 'aborted');
  }

  return {
    createTicketFromTemplate,
    advance,
    resolveHumanGate,
    abort,
    reconcileTicket,
  };
}

export type Engine = ReturnType<typeof createEngine>;
