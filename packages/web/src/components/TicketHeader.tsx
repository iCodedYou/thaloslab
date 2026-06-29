import type { Ticket } from '@thaloslab/shared';
import { DOT_CLASS, TEXT_CLASS, TICKET_TONE } from './status';

export function TicketHeader({ ticket }: { ticket: Ticket }) {
  const tone = TICKET_TONE[ticket.status] ?? 'dim';
  return (
    <header className="border-b border-line pb-3">
      <h1 className="text-base font-medium text-fg">{ticket.title}</h1>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs">
        <span className="flex items-center gap-1.5">
          <span className={`h-2 w-2 rounded-full ${DOT_CLASS[tone]}`} />
          <span className={TEXT_CLASS[tone]}>{ticket.status}</span>
        </span>
        <span className="text-faint">mode: {ticket.mode}</span>
        {ticket.taskType && <span className="text-faint">type: {ticket.taskType}</span>}
        {ticket.blastRadius && ticket.blastRadius.length > 0 && (
          <span className="text-warn">blast: {ticket.blastRadius.join(', ')}</span>
        )}
      </div>
    </header>
  );
}

export function EmptyDetail() {
  return (
    <div className="flex h-full items-center justify-center">
      <p className="text-sm text-faint">Select or file a ticket to begin.</p>
    </div>
  );
}
