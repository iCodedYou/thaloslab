// Insights tab (SPEC §15, Phase 6) — orchestration observability. METADATA ONLY: token/cost/timing
// rollups + run-status + escalation counts per provider and per collab peer. It renders the read-only
// /api/observability rollups; no prompt, no output, no agent content ever reaches this surface.
import { type Rollup, useObservability } from '../api/queries';
import { useUiStore } from '../state/ui';

const fmtUsd = (n: number) => `$${n.toFixed(n < 0.01 ? 4 : 2)}`;
const fmtMs = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n}ms`);
const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

function StatusBar({ breakdown }: { breakdown: Record<string, number> }) {
  const total = Object.values(breakdown).reduce((a, b) => a + b, 0) || 1;
  const tone: Record<string, string> = {
    ok: 'bg-ok',
    error: 'bg-danger',
    interrupted: 'bg-warn',
    timeout: 'bg-warn',
    running: 'bg-dim',
  };
  return (
    <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-raised">
      {Object.entries(breakdown).map(([s, n]) => (
        <div
          key={s}
          className={tone[s] ?? 'bg-faint'}
          style={{ width: `${(n / total) * 100}%` }}
          title={`${s}: ${n}`}
        />
      ))}
    </div>
  );
}

function RollupCard({ r }: { r: Rollup }) {
  return (
    <div className="rounded-md border border-line bg-surface p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="truncate font-mono text-xs text-fg">{r.scopeId}</span>
        <span className="font-mono text-[11px] text-accent">{fmtUsd(r.costUsd)}</span>
      </div>
      <div className="mb-2 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[10px] text-faint">
        <span>{r.runCount} runs</span>
        <span>
          ↓{fmtK(r.inputTokens)} ↑{fmtK(r.outputTokens)} tok
        </span>
        <span>{fmtMs(r.durationMs)}</span>
      </div>
      <StatusBar breakdown={r.statusBreakdown} />
    </div>
  );
}

export function InsightsPage() {
  const projectId = useUiStore((s) => s.selectedProjectId);
  const { data, isLoading } = useObservability(projectId);

  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-faint">Select a project to see its orchestration telemetry.</p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto p-6">
      <h2 className="mb-1 font-mono text-sm text-fg">Insights</h2>
      <p className="mb-4 text-xs text-faint">
        Orchestration telemetry — cost, tokens, timings, run status. Metadata only; no prompts or
        agent output cross this surface.
      </p>
      {isLoading && <p className="text-xs text-faint">Loading…</p>}
      {data && (
        <>
          <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="total cost" value={fmtUsd(data.project.costUsd)} />
            <Stat label="runs" value={`${data.project.runCount}`} />
            <Stat
              label="tokens"
              value={`${fmtK(data.project.inputTokens + data.project.outputTokens)}`}
            />
            <Stat label="escalations" value={`${data.escalationCount}`} />
          </div>

          <h3 className="mb-2 font-mono text-[11px] uppercase tracking-wide text-dim">
            By provider
          </h3>
          {data.byProvider.length === 0 ? (
            <p className="text-xs text-faint">No runs yet.</p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {data.byProvider.map((r) => (
                <RollupCard key={r.scopeId} r={r} />
              ))}
            </div>
          )}

          {data.byPeer.length > 0 && (
            <>
              <h3 className="mb-2 mt-6 font-mono text-[11px] uppercase tracking-wide text-dim">
                By collab peer (cost attribution)
              </h3>
              <div className="grid gap-2 sm:grid-cols-2">
                {data.byPeer.map((r) => (
                  <RollupCard key={r.scopeId} r={r} />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-line bg-surface p-3">
      <div className="font-mono text-lg text-fg">{value}</div>
      <div className="font-mono text-[10px] uppercase tracking-wide text-faint">{label}</div>
    </div>
  );
}
