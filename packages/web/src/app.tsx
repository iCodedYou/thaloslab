import { LeftRail } from './layout/LeftRail';
import { AgentsPage } from './pages/Agents';
import { CollabPage } from './pages/Collab';
import { MainPage } from './pages/Main';
import { OrchestratorPage } from './pages/Orchestrator';
import { TicketsPage } from './pages/Tickets';
import { useUiStore } from './state/ui';

function Placeholder({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center">
      <p className="text-sm text-faint">{label} — coming in a later phase.</p>
    </div>
  );
}

export function App() {
  const activeNav = useUiStore((s) => s.activeNav);
  return (
    <div className="flex h-full">
      <LeftRail />
      <main className="min-w-0 flex-1 overflow-hidden">
        {activeNav === 'projects' && <MainPage />}
        {activeNav === 'orchestrator' && <OrchestratorPage />}
        {activeNav === 'tickets' && <TicketsPage />}
        {activeNav === 'agents' && <AgentsPage />}
        {activeNav === 'collab' && <CollabPage />}
        {activeNav === 'settings' && <Placeholder label="Settings" />}
      </main>
    </div>
  );
}
