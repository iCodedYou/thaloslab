// DAG walker helpers. Dependencies are by stageId, and a stageId may have MULTIPLE tasks (fan-out
// children share their parent's target stageId). The dependency is therefore an ALL-OF barrier: a
// dependency stageId is satisfied iff its group is non-empty and EVERY task in it is satisfied.
// This is what makes `integrate (dependsOn:['impl'])` wait for all parallel engineers.
import type { Task } from '@thaloslab/shared';

const SATISFIED: ReadonlySet<string> = new Set(['passed', 'done']);

export function groupByStage(tasks: Task[]): Map<string, Task[]> {
  const map = new Map<string, Task[]>();
  for (const t of tasks) {
    const group = map.get(t.stageId);
    if (group) group.push(t);
    else map.set(t.stageId, [t]);
  }
  return map;
}

export function depsSatisfied(task: Task, byStageId: Map<string, Task[]>): boolean {
  return task.dependsOn.every((stageId) => {
    const group = byStageId.get(stageId);
    return group !== undefined && group.length > 0 && group.every((d) => SATISFIED.has(d.state));
  });
}

/** Pending tasks whose dependency groups are all-satisfied — the set to claim+dispatch this tick. */
export function readyTasks(tasks: Task[]): Task[] {
  const byStageId = groupByStage(tasks);
  return tasks.filter((t) => t.state === 'pending' && depsSatisfied(t, byStageId));
}
