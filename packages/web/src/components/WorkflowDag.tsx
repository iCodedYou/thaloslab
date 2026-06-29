import type { Task } from '@thaloslab/shared';
import { DOT_CLASS, TASK_TONE, TEXT_CLASS } from './status';

// Topological-ish ordering: stages first (by dependency depth), gates inline. For Phase 1's
// linear-ish bug-fix DAG a stable creation order reads correctly; we annotate deps for clarity.
export function WorkflowDag({ tasks }: { tasks: Task[] }) {
  if (tasks.length === 0) return <p className="text-sm text-faint">No task graph yet.</p>;
  return (
    <ol className="flex flex-col gap-1.5">
      {tasks.map((t) => {
        const tone = TASK_TONE[t.state] ?? 'dim';
        return (
          <li
            key={t.id}
            className="flex items-center gap-3 rounded-md border border-line bg-surface px-3 py-2"
          >
            <span className={`h-2 w-2 shrink-0 rounded-full ${DOT_CLASS[tone]}`} />
            <span className="font-mono text-sm text-fg">{t.stageId}</span>
            {t.kind === 'gate' && (
              <span className="rounded bg-raised px-1.5 py-0.5 font-mono text-[10px] text-dim">
                gate
              </span>
            )}
            <span className={`ml-auto font-mono text-xs ${TEXT_CLASS[tone]}`}>{t.state}</span>
            {(t.retryCount > 0 || t.attempt > 0) && (
              <span className="font-mono text-[10px] text-faint">
                r{t.retryCount}/a{t.attempt}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
