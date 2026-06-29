// Agents tab (SPEC §12): the assembled per-project roster, inspectable and editable. Authority +
// access are shown read-only (they're policy, clamped server-side); name, system prompt, and
// active/inactive are editable and persist through the agents repo + .thalos/agents mirror.
import type { AgentConfig } from '@thaloslab/shared';
import { useState } from 'react';
import { useAgents, useUpdateAgent } from '../api/queries';
import { useUiStore } from '../state/ui';

function AgentCard({ agent }: { agent: AgentConfig }) {
  const update = useUpdateAgent();
  const [name, setName] = useState(agent.name);
  const [prompt, setPrompt] = useState(agent.systemPrompt);
  const dirty = name !== agent.name || prompt !== agent.systemPrompt;

  return (
    <div className="rounded-md border border-line bg-surface p-4">
      <div className="flex items-center gap-3">
        <input
          className="min-w-0 flex-1 rounded bg-raised px-2 py-1 font-mono text-sm text-fg outline-none focus:ring-1 focus:ring-line"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <span className="rounded bg-raised px-1.5 py-0.5 font-mono text-[10px] text-dim">
          {agent.role}
        </span>
        <button
          type="button"
          className={`rounded px-2 py-0.5 font-mono text-[10px] ${
            agent.status === 'active' ? 'bg-green-900/40 text-green-300' : 'bg-raised text-faint'
          }`}
          onClick={() =>
            update.mutate({
              id: agent.id,
              patch: { status: agent.status === 'active' ? 'inactive' : 'active' },
            })
          }
        >
          {agent.status}
        </button>
      </div>

      <div className="mt-2 flex flex-wrap gap-2 font-mono text-[10px] text-faint">
        <span>auth: {agent.authority}</span>
        <span>net: {agent.access.network}</span>
        <span>scope: {agent.access.pathScope}</span>
        <span>by: {agent.createdBy}</span>
      </div>

      <textarea
        className="mt-3 h-20 w-full resize-y rounded bg-raised px-2 py-1 text-xs text-fg outline-none focus:ring-1 focus:ring-line"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
      />

      {dirty && (
        <div className="mt-2 flex justify-end gap-2">
          <button
            type="button"
            className="rounded px-2 py-1 font-mono text-[11px] text-dim hover:text-fg"
            onClick={() => {
              setName(agent.name);
              setPrompt(agent.systemPrompt);
            }}
          >
            reset
          </button>
          <button
            type="button"
            className="rounded bg-accent px-3 py-1 font-mono text-[11px] text-bg"
            onClick={() => update.mutate({ id: agent.id, patch: { name, systemPrompt: prompt } })}
          >
            save
          </button>
        </div>
      )}
    </div>
  );
}

export function AgentsPage() {
  const projectId = useUiStore((s) => s.selectedProjectId);
  const { data: agents, isLoading } = useAgents(projectId);

  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-faint">Select a project to view its roster.</p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto p-6">
      <h2 className="mb-1 font-mono text-sm text-fg">Roster</h2>
      <p className="mb-4 text-xs text-faint">
        Assembled per project. Authority + access are clamped policy (read-only); name, prompt, and
        active state are editable and versioned in <code>.thalos/agents</code>.
      </p>
      {isLoading && <p className="text-xs text-faint">Loading…</p>}
      {agents && agents.length === 0 && (
        <p className="text-xs text-faint">No agents yet — they are assembled when a ticket runs.</p>
      )}
      <div className="grid gap-3">
        {agents?.map((a) => (
          <AgentCard key={a.id} agent={a} />
        ))}
      </div>
    </div>
  );
}
