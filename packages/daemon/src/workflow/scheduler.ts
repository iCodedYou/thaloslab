// DAG walker helpers. A task is ready when it is still pending and every dependency (referenced
// by stageId) has reached a satisfied state. Pure — the engine claims + dispatches the ready set.
import type { Task } from '@thaloslab/shared';

const SATISFIED: ReadonlySet<string> = new Set(['passed', 'done']);

export function depsSatisfied(task: Task, byStageId: Map<string, Task>): boolean {
  return task.dependsOn.every((stageId) => {
    const dep = byStageId.get(stageId);
    return dep !== undefined && SATISFIED.has(dep.state);
  });
}

/** Pending tasks whose dependencies are all satisfied — the set to claim+dispatch this tick. */
export function readyTasks(tasks: Task[]): Task[] {
  const byStageId = new Map(tasks.map((t) => [t.stageId, t]));
  return tasks.filter((t) => t.state === 'pending' && depsSatisfied(t, byStageId));
}
