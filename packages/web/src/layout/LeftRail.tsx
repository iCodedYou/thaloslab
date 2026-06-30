import { useUiStore } from '../state/ui';

const NAV = [
  { id: 'projects', label: 'Projects' },
  { id: 'orchestrator', label: 'Orchestrator' },
  { id: 'tickets', label: 'Tickets' },
  { id: 'agents', label: 'Agents' },
  { id: 'collab', label: 'Collab' },
  { id: 'insights', label: 'Insights' },
  { id: 'settings', label: 'Settings' },
];

export function LeftRail() {
  const { activeNav, setActiveNav } = useUiStore();
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-surface">
      <div className="flex h-14 items-center gap-2 border-b border-line px-4">
        <span className="h-2.5 w-2.5 rounded-full bg-accent" />
        <span className="font-mono text-sm tracking-tight text-fg">
          thalos<span className="text-dim">lab</span>
        </span>
      </div>
      <nav className="flex flex-col gap-0.5 p-2">
        {NAV.map((item) => {
          const active = item.id === activeNav;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setActiveNav(item.id)}
              className={`rounded-md px-3 py-1.5 text-left text-sm transition-colors ${
                active ? 'bg-raised text-fg' : 'text-dim hover:bg-raised hover:text-fg'
              }`}
            >
              {item.label}
            </button>
          );
        })}
      </nav>
      <div className="mt-auto border-t border-line px-4 py-3">
        <span className="font-mono text-xs text-faint">phase 0 · preview</span>
      </div>
    </aside>
  );
}
