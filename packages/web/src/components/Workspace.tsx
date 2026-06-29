// Shared left column: project picker + ticket composer + ticket list. Both the Orchestrator and
// Tickets pages render this beside their detail view, driven by the same selection store.
import { useEffect, useState } from 'react';
import type { ExecutionMode } from '@thaloslab/shared';
import { useCreateTicket, useProjects, useTickets } from '../api/queries';
import { useUiStore } from '../state/ui';
import { TICKET_TONE, DOT_CLASS } from './status';

const MODES: ExecutionMode[] = ['preview', 'mock', 'live'];

export function Workspace() {
  const projects = useProjects();
  const { selectedProjectId, setSelectedProjectId, selectedTicketId, setSelectedTicketId } =
    useUiStore();

  // Auto-select the first project once loaded.
  useEffect(() => {
    if (!selectedProjectId && projects.data?.[0]) setSelectedProjectId(projects.data[0].id);
  }, [projects.data, selectedProjectId, setSelectedProjectId]);

  const tickets = useTickets(selectedProjectId);
  const create = useCreateTicket();
  const [title, setTitle] = useState('');
  const [mode, setMode] = useState<ExecutionMode>('mock');

  const submit = () => {
    if (!selectedProjectId || !title.trim()) return;
    create.mutate(
      { projectId: selectedProjectId, title: title.trim(), mode },
      { onSuccess: (r) => setSelectedTicketId(r.ticket.id) },
    );
    setTitle('');
  };

  return (
    <div className="flex w-80 shrink-0 flex-col gap-4 border-r border-line p-4">
      <div>
        <label className="mb-1 block text-xs uppercase tracking-wide text-dim">Project</label>
        <select
          value={selectedProjectId ?? ''}
          onChange={(e) => setSelectedProjectId(e.target.value || undefined)}
          className="w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-fg"
        >
          {(projects.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      <div className="rounded-lg border border-line bg-surface p-3">
        <label className="mb-1 block text-xs uppercase tracking-wide text-dim">New ticket</label>
        <textarea
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Describe the bug… (e.g. the export button 500s on large datasets)"
          rows={3}
          className="w-full resize-none rounded-md border border-line bg-bg px-2 py-1.5 text-sm text-fg placeholder:text-faint"
        />
        <div className="mt-2 flex items-center gap-2">
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as ExecutionMode)}
            className="rounded-md border border-line bg-bg px-2 py-1 font-mono text-xs text-dim"
          >
            {MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={submit}
            disabled={!selectedProjectId || !title.trim() || create.isPending}
            className="ml-auto rounded-md bg-accent px-3 py-1 text-sm text-black transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            File
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mb-2 text-xs uppercase tracking-wide text-dim">Tickets</div>
        <ul className="flex flex-col gap-1">
          {(tickets.data ?? []).map((t) => {
            const tone = TICKET_TONE[t.status] ?? 'dim';
            const active = t.id === selectedTicketId;
            return (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => setSelectedTicketId(t.id)}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-left transition-colors ${
                    active ? 'bg-raised' : 'hover:bg-surface'
                  }`}
                >
                  <span className={`h-2 w-2 shrink-0 rounded-full ${DOT_CLASS[tone]}`} />
                  <span className="truncate text-sm text-fg">{t.title}</span>
                  <span className="ml-auto font-mono text-[10px] text-faint">{t.status}</span>
                </button>
              </li>
            );
          })}
          {tickets.data?.length === 0 && (
            <li className="px-2 py-1 text-sm text-faint">No tickets yet.</li>
          )}
        </ul>
      </div>
    </div>
  );
}
