import type { ReactNode } from 'react';
import type { DetectedProvider } from '@thaloslab/shared';
import { useProjects, useProviders } from '../api/queries';

function StatusDot({ tone }: { tone: 'ok' | 'warn' | 'off' }) {
  const color = tone === 'ok' ? 'bg-ok' : tone === 'warn' ? 'bg-warn' : 'bg-faint';
  return <span className={`h-2 w-2 shrink-0 rounded-full ${color}`} />;
}

function providerState(p: DetectedProvider): { tone: 'ok' | 'warn' | 'off'; label: string } {
  if (!p.installed) return { tone: 'off', label: 'not found' };
  if (!p.authenticated) return { tone: 'warn', label: 'needs login' };
  return { tone: 'ok', label: `ready${p.version ? ` · ${p.version}` : ''}` };
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-dim">{children}</h2>;
}

export function MainPage() {
  const projects = useProjects();
  const providers = useProviders();

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-10 px-8 py-10">
      <header>
        <h1 className="text-xl font-semibold text-fg">Thalos Lab</h1>
        <p className="mt-1 text-sm text-dim">
          Local orchestration of your installed AI coding CLIs as a role-based engineering team.
        </p>
      </header>

      <section>
        <SectionTitle>Projects</SectionTitle>
        {projects.isLoading ? (
          <p className="text-sm text-faint">Loading…</p>
        ) : projects.data && projects.data.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {projects.data.map((p) => (
              <li
                key={p.id}
                className="flex items-center justify-between rounded-lg border border-line bg-surface px-4 py-3"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm text-fg">{p.name}</div>
                  <div className="truncate font-mono text-xs text-faint">{p.repoPath}</div>
                </div>
                <span className="ml-4 font-mono text-xs text-dim">{p.phase}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="rounded-lg border border-dashed border-line px-4 py-8 text-center text-sm text-faint">
            No projects yet — create one from scratch or import from GitHub.
          </div>
        )}
      </section>

      <section>
        <SectionTitle>Connected AI agents</SectionTitle>
        {providers.data && providers.data.length > 0 ? (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {providers.data.map((p) => {
              const state = providerState(p);
              return (
                <div
                  key={p.id}
                  className="flex items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3"
                >
                  <StatusDot tone={state.tone} />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-fg">{p.displayName}</div>
                    <div className="truncate font-mono text-xs text-faint">{state.label}</div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-sm text-faint">No providers detected.</p>
        )}
      </section>
    </div>
  );
}
