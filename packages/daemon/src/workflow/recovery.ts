// Crash recovery (runs at boot, between migrate and serve). No invoke survives process death, so
// every `running` run at boot is dead: reap it, reconcile each interrupted task against disk
// (default: reset to `pending` for a clean re-run; production may move to `review` if the worktree
// already holds a committed diff — reconcile-against-disk, not blind replay), then re-advance every
// running/blocked ticket. Tasks already `passed`/`done` are untouched — completed work is NOT re-run.
import type { Task } from '@thaloslab/shared';
import { interruptRunningRuns } from '../store/repositories/runs';
import { listTasksByTicket, updateTask } from '../store/repositories/tasks';
import { listTicketsByStatus } from '../store/repositories/tickets';
import type { Engine } from './engine';

export interface RecoverDeps {
  reconcile?: (task: Task) => 'pending' | 'review';
  now?: () => number;
}

const IN_FLIGHT: ReadonlySet<string> = new Set(['running', 'fixing', 'review']);

export async function recoverInFlight(engine: Engine, deps: RecoverDeps = {}): Promise<string[]> {
  const now = deps.now?.() ?? Date.now();
  const reconcile = deps.reconcile ?? (() => 'pending' as const);

  interruptRunningRuns(now);

  const tickets = listTicketsByStatus(['running', 'blocked']);
  for (const ticket of tickets) {
    for (const task of listTasksByTicket(ticket.id)) {
      if (IN_FLIGHT.has(task.state)) {
        updateTask(task.id, { state: reconcile(task), startedAt: null });
      }
    }
  }

  for (const ticket of tickets) {
    await engine.advance(ticket.id);
  }
  return tickets.map((t) => t.id);
}
