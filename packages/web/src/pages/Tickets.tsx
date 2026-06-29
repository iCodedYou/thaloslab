import { useTicket } from '../api/queries';
import { useTicketStream } from '../api/ws';
import { GateCard } from '../components/GateCard';
import { EmptyDetail, TicketHeader } from '../components/TicketHeader';
import { WorkflowDag } from '../components/WorkflowDag';
import { Workspace } from '../components/Workspace';
import { useUiStore } from '../state/ui';

function SectionTitle({ children }: { children: string }) {
  return <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-dim">{children}</h2>;
}

export function TicketsPage() {
  const ticketId = useUiStore((s) => s.selectedTicketId);
  const detail = useTicket(ticketId);
  useTicketStream(ticketId);

  const pendingGates =
    detail.data?.gates.filter((g) => g.status === 'pending' && g.kind === 'human') ?? [];

  return (
    <div className="flex h-full">
      <Workspace />
      <div className="min-w-0 flex-1 overflow-auto">
        {!ticketId ? (
          <EmptyDetail />
        ) : detail.data ? (
          <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-6">
            <TicketHeader ticket={detail.data.ticket} />

            {pendingGates.map((g) => (
              <GateCard key={g.id} gate={g} />
            ))}

            <section>
              <SectionTitle>Workflow</SectionTitle>
              <WorkflowDag tasks={detail.data.tasks} />
            </section>

            <section>
              <SectionTitle>Artifacts</SectionTitle>
              {detail.data.artifacts.length > 0 ? (
                <ul className="flex flex-col gap-1">
                  {detail.data.artifacts.map((a) => (
                    <li key={a.id} className="font-mono text-xs text-dim">
                      <span className="text-faint">{a.kind}</span> {a.path}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-faint">No artifacts yet.</p>
              )}
            </section>
          </div>
        ) : (
          <p className="px-6 py-6 text-sm text-faint">Loading…</p>
        )}
      </div>
    </div>
  );
}
