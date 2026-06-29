import { useTicket } from '../api/queries';
import { useTicketStream } from '../api/ws';
import { ChatMessage } from '../components/ChatMessage';
import { GateCard } from '../components/GateCard';
import { EmptyDetail, TicketHeader } from '../components/TicketHeader';
import { Workspace } from '../components/Workspace';
import { useUiStore } from '../state/ui';

export function OrchestratorPage() {
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
          <div className="mx-auto flex max-w-3xl flex-col gap-3 px-6 py-6">
            <TicketHeader ticket={detail.data.ticket} />
            {detail.data.messages.map((m) => (
              <ChatMessage key={m.id} message={m.message} />
            ))}
            {pendingGates.map((g) => (
              <GateCard key={g.id} gate={g} />
            ))}
          </div>
        ) : (
          <p className="px-6 py-6 text-sm text-faint">Loading…</p>
        )}
      </div>
    </div>
  );
}
