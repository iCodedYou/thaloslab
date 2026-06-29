// The all-of barrier is what makes fan-out safe: a downstream stage depending on `impl` must wait
// for EVERY impl child (parallel engineers), not just the first one the old last-wins map saw.
import type { Task, TaskState } from '@thaloslab/shared';
import { describe, expect, it } from 'vitest';
import { depsSatisfied, groupByStage, readyTasks } from './scheduler';

function task(id: string, stageId: string, state: TaskState, dependsOn: string[] = []): Task {
  return {
    id,
    ticketId: 'tk',
    stageId,
    kind: 'stage',
    laneId: `tk:${id}`,
    dependsOn,
    state,
    retryCount: 0,
    attempt: 0,
    createdAt: 1,
  };
}

describe('group-by-stage all-of barrier', () => {
  it('groups multiple tasks that share a stageId', () => {
    const tasks = [task('a', 'impl', 'running'), task('b', 'impl', 'pending')];
    expect(groupByStage(tasks).get('impl')).toHaveLength(2);
  });

  it('an integrate task waits until ALL impl children pass (not just one)', () => {
    const a = task('a', 'impl', 'passed');
    const b = task('b', 'impl', 'running');
    const integrate = task('int', 'integrate', 'pending', ['impl']);
    const by = groupByStage([a, b, integrate]);

    expect(depsSatisfied(integrate, by)).toBe(false); // b still running
    expect(readyTasks([a, b, integrate])).not.toContainEqual(integrate);

    b.state = 'passed';
    const by2 = groupByStage([a, b, integrate]);
    expect(depsSatisfied(integrate, by2)).toBe(true);
    expect(readyTasks([a, b, integrate]).map((t) => t.id)).toContain('int');
  });

  it('an empty dependency group is NOT satisfied (no fan-out child materialized yet)', () => {
    const integrate = task('int', 'integrate', 'pending', ['impl']);
    expect(depsSatisfied(integrate, groupByStage([integrate]))).toBe(false);
  });

  it('dispatches every ready same-stage child concurrently', () => {
    const arch = task('arch', 'plan', 'passed');
    const c0 = task('c0', 'impl', 'pending', ['plan']);
    const c1 = task('c1', 'impl', 'pending', ['plan']);
    const c2 = task('c2', 'impl', 'pending', ['plan']);
    const ready = readyTasks([arch, c0, c1, c2]).map((t) => t.id);
    expect(ready).toEqual(['c0', 'c1', 'c2']);
  });
});
