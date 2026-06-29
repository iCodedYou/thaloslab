import type { TaskState } from '@thaloslab/shared';
import { describe, expect, it } from 'vitest';
import {
  IllegalTransitionError,
  canTransition,
  isFinal,
  legalEvents,
  nextState,
  type TaskEventName,
} from './state-machine';

describe('state-machine: legal transitions', () => {
  const legal: Array<[TaskState, TaskEventName, TaskState]> = [
    ['pending', 'claim', 'running'],
    ['running', 'to-review', 'review'],
    ['running', 'to-passed', 'passed'],
    ['running', 'gates-failed', 'fixing'],
    ['running', 'block-human', 'blocked-on-human'],
    ['running', 'escalate', 'escalated'],
    ['running', 'fail', 'failed'],
    ['review', 'review-approved', 'passed'],
    ['review', 'review-rejected', 'fixing'],
    ['review', 'escalate', 'escalated'],
    ['fixing', 'retry', 'running'],
    ['fixing', 'escalate', 'escalated'],
    ['blocked-on-human', 'human-approved', 'passed'],
    ['blocked-on-human', 'human-rejected', 'failed'],
    ['blocked-on-human', 'human-changes', 'fixing'],
    ['passed', 'complete', 'done'],
    ['passed', 'block-human', 'blocked-on-human'],
  ];

  for (const [from, event, to] of legal) {
    it(`${from} --${event}--> ${to}`, () => {
      expect(nextState(from, event)).toBe(to);
      expect(canTransition(from, event)).toBe(true);
    });
  }

  it('the fix↔review loop cycles legally', () => {
    let s: TaskState = 'pending';
    s = nextState(s, 'claim'); // running
    s = nextState(s, 'to-review'); // review
    s = nextState(s, 'review-rejected'); // fixing
    s = nextState(s, 'retry'); // running
    s = nextState(s, 'to-review'); // review
    s = nextState(s, 'review-approved'); // passed
    s = nextState(s, 'complete'); // done
    expect(s).toBe('done');
  });
});

describe('state-machine: illegal transitions throw', () => {
  const illegal: Array<[TaskState, TaskEventName]> = [
    ['pending', 'retry'],
    ['pending', 'to-passed'],
    ['running', 'claim'],
    ['done', 'claim'],
    ['failed', 'retry'],
    ['escalated', 'complete'],
    ['blocked-on-human', 'claim'],
    ['review', 'claim'],
  ];

  for (const [from, event] of illegal) {
    it(`${from} --${event}--> throws`, () => {
      expect(() => nextState(from, event)).toThrow(IllegalTransitionError);
      expect(canTransition(from, event)).toBe(false);
    });
  }
});

describe('state-machine: terminal states', () => {
  it('failed / escalated / done are final with no legal events', () => {
    for (const s of ['failed', 'escalated', 'done'] as TaskState[]) {
      expect(isFinal(s)).toBe(true);
      expect(legalEvents(s)).toHaveLength(0);
    }
  });
  it('non-terminal states are not final', () => {
    for (const s of [
      'pending',
      'running',
      'review',
      'fixing',
      'blocked-on-human',
      'passed',
    ] as TaskState[]) {
      expect(isFinal(s)).toBe(false);
    }
  });
});
