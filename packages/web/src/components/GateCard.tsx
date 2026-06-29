import type { Gate, GateDecision } from '@thaloslab/shared';
import { useResolveGate } from '../api/queries';

const ACTIONS: { decision: GateDecision; label: string; cls: string }[] = [
  { decision: 'approve', label: 'Approve', cls: 'bg-accent text-black hover:opacity-90' },
  {
    decision: 'request-changes',
    label: 'Request changes',
    cls: 'border border-line text-dim hover:text-fg hover:bg-raised',
  },
  { decision: 'reject', label: 'Reject', cls: 'border border-line text-danger hover:bg-raised' },
];

export function GateCard({ gate }: { gate: Gate }) {
  const resolve = useResolveGate();
  return (
    <div className="rounded-lg border border-warn/40 bg-surface p-4">
      <div className="mb-1 flex items-center gap-2">
        <span className="h-2 w-2 rounded-full bg-warn" />
        <span className="text-xs font-medium uppercase tracking-wide text-warn">Approval gate</span>
      </div>
      <p className="mb-3 text-sm text-fg">{gate.title ?? gate.prompt ?? 'Approval required'}</p>
      <div className="flex flex-wrap gap-2">
        {ACTIONS.map((a) => (
          <button
            key={a.decision}
            type="button"
            disabled={resolve.isPending}
            onClick={() => resolve.mutate({ gateId: gate.id, decision: a.decision })}
            className={`rounded-md px-3 py-1.5 text-sm transition-colors disabled:opacity-50 ${a.cls}`}
          >
            {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}
