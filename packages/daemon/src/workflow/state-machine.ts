// Pure task-graph state machine (SPEC §7): pending → running → (review → fixing)* →
// blocked-on-human → passed | failed | escalated | done. No I/O — the scheduler decides WHICH
// event to fire; this module only validates and computes the next state. Heavily unit-tested.
import type { TaskState } from '@thaloslab/shared';

export type TaskEventName =
  | 'claim' // pending -> running (the atomic single-flight claim)
  | 'to-review' // running -> review (gates green, an adversarial review follows)
  | 'to-passed' // running -> passed (gates green, no review)
  | 'gates-failed' // running -> fixing (a gate failed, under caps)
  | 'review-approved' // review -> passed
  | 'review-rejected' // review -> fixing (bounce back into the loop)
  | 'retry' // fixing -> running (re-dispatch the stage)
  | 'block-human' // running|passed -> blocked-on-human (a human gate)
  | 'human-approved' // blocked-on-human -> passed
  | 'human-rejected' // blocked-on-human -> failed
  | 'human-changes' // blocked-on-human -> fixing
  | 'escalate' // running|review|fixing -> escalated (doom-loop / cap hit)
  | 'complete' // passed -> done
  | 'fail'; // running|review -> failed

const TABLE: Record<TaskState, Partial<Record<TaskEventName, TaskState>>> = {
  pending: { claim: 'running' },
  running: {
    'to-review': 'review',
    'to-passed': 'passed',
    'gates-failed': 'fixing',
    'block-human': 'blocked-on-human',
    escalate: 'escalated',
    fail: 'failed',
  },
  review: {
    'review-approved': 'passed',
    'review-rejected': 'fixing',
    escalate: 'escalated',
    fail: 'failed',
  },
  fixing: {
    retry: 'running',
    escalate: 'escalated',
    fail: 'failed',
  },
  'blocked-on-human': {
    'human-approved': 'passed',
    'human-rejected': 'failed',
    'human-changes': 'fixing',
  },
  passed: {
    complete: 'done',
    'block-human': 'blocked-on-human',
  },
  failed: {},
  escalated: {},
  done: {},
};

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: TaskState,
    readonly event: TaskEventName,
  ) {
    super(`illegal task transition: ${from} --${event}-->`);
    this.name = 'IllegalTransitionError';
  }
}

/** Computes the next state or throws on an illegal (state, event) pair. */
export function nextState(from: TaskState, event: TaskEventName): TaskState {
  const to = TABLE[from][event];
  if (to === undefined) throw new IllegalTransitionError(from, event);
  return to;
}

export function canTransition(from: TaskState, event: TaskEventName): boolean {
  return TABLE[from][event] !== undefined;
}

/** Fully terminal states — no further transitions are legal. */
export function isFinal(state: TaskState): boolean {
  return state === 'failed' || state === 'escalated' || state === 'done';
}

export function legalEvents(from: TaskState): TaskEventName[] {
  return Object.keys(TABLE[from]) as TaskEventName[];
}
