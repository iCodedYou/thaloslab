// Collab tab (SPEC §11). A SECURITY surface, not a nicety:
//  - peer admission is an EXPLICIT host action (a valid join token alone never authorizes — the
//    transport trust model), so admit is a deliberate button, never automatic;
//  - a peer with no VERIFIED sandbox is shown unroutable (collab is sandbox-required, fail-closed);
//  - the manifest viewer shows the REAL persisted record of exactly what crossed the trust boundary
//    (path + sha256 of every file sent, and the secret-bearing files that were withheld) — the
//    INFORM half of the one-way data-confidentiality axis (there is no claw-back once data leaves).
import {
  type CollabPeerView,
  useCollab,
  useCollabAction,
  useCollabManifests,
} from '../api/queries';
import { useUiStore } from '../state/ui';

function Dot({ ok }: { ok: boolean }) {
  return <span className={`h-2 w-2 shrink-0 rounded-full ${ok ? 'bg-ok' : 'bg-danger'}`} />;
}

function PeerRow({ peer }: { peer: CollabPeerView }) {
  const act = useCollabAction();
  return (
    <div className="flex items-center gap-3 rounded-md border border-line bg-surface px-4 py-3">
      <Dot ok={peer.sandboxOk} />
      <div className="min-w-0 flex-1">
        <div className="font-mono text-sm text-fg">{peer.peerId}</div>
        <div className="truncate font-mono text-[10px] text-faint">
          {peer.vendors.join(', ') || 'no CLIs'} ·{' '}
          {peer.sandboxOk ? 'sandbox verified' : 'NO verified sandbox — unroutable'}
        </div>
      </div>
      <span
        className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${
          peer.routable ? 'bg-green-900/40 text-green-300' : 'bg-raised text-faint'
        }`}
      >
        {peer.revoked
          ? 'revoked'
          : peer.routable
            ? 'routable'
            : peer.admitted
              ? 'admitted'
              : peer.joinRequested
                ? 'awaiting admit'
                : 'connected'}
      </span>
      {/* Admit is the EXPLICIT human step — only offered after a valid token was presented. */}
      {peer.joinRequested && !peer.admitted && !peer.revoked && (
        <button
          type="button"
          className="rounded bg-accent px-2 py-1 font-mono text-[11px] text-bg"
          onClick={() => act.mutate(`/api/collab/peers/${peer.peerId}/admit`)}
        >
          admit
        </button>
      )}
      {peer.admitted && !peer.revoked && (
        <button
          type="button"
          className="rounded px-2 py-1 font-mono text-[11px] text-danger hover:bg-raised"
          onClick={() => act.mutate(`/api/collab/peers/${peer.peerId}/revoke`)}
        >
          revoke
        </button>
      )}
    </div>
  );
}

export function CollabPage() {
  const projectId = useUiStore((s) => s.selectedProjectId);
  const { data: state } = useCollab();
  const { data: manifests } = useCollabManifests(projectId);
  const act = useCollabAction();
  const active = state?.active ?? false;

  return (
    <div className="h-full overflow-auto p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="font-mono text-sm text-fg">Collab</h2>
          <p className="mt-1 text-xs text-faint">
            Pool peers' AI CLIs. Sandbox-required + token-gated + explicit admit; the host sees
            exactly what's shared.
          </p>
        </div>
        <button
          type="button"
          className={`rounded px-3 py-1 font-mono text-[11px] ${
            active ? 'bg-green-900/40 text-green-300' : 'bg-raised text-dim'
          }`}
          onClick={() => act.mutate(active ? '/api/collab/disable' : '/api/collab/enable')}
        >
          {active ? 'collab on' : 'collab off'}
        </button>
      </div>

      <h3 className="mb-2 font-mono text-[11px] uppercase tracking-wide text-dim">Peers</h3>
      {!state || state.peers.length === 0 ? (
        <p className="text-xs text-faint">
          No peers connected. {active ? '' : 'Enable collab and share a one-time join token.'}
        </p>
      ) : (
        <div className="grid gap-2">
          {state.peers.map((p) => (
            <PeerRow key={p.peerId} peer={p} />
          ))}
        </div>
      )}

      <h3 className="mb-2 mt-6 font-mono text-[11px] uppercase tracking-wide text-dim">
        What crossed (context manifests)
      </h3>
      {!projectId ? (
        <p className="text-xs text-faint">Select a project to see its shared-context history.</p>
      ) : !manifests || manifests.length === 0 ? (
        <p className="text-xs text-faint">No context has been shared yet.</p>
      ) : (
        <div className="grid gap-2">
          {manifests.map((m) => (
            <div key={m.runId} className="rounded-md border border-line bg-surface p-3">
              <div className="mb-2 flex items-center justify-between font-mono text-[11px] text-dim">
                <span>→ {m.peerId}</span>
                <span className="text-faint">
                  {m.entries.length} file(s) sent · {m.excluded.length} withheld
                </span>
              </div>
              <ul className="grid gap-0.5 font-mono text-[10px]">
                {m.entries.map((e) => (
                  <li key={e.path} className="flex justify-between gap-3 text-faint">
                    <span className="truncate text-dim">{e.path}</span>
                    <span title={e.sha256}>{e.sha256.slice(0, 12)}…</span>
                  </li>
                ))}
                {m.excluded.map((p) => (
                  <li key={p} className="text-danger/70">
                    withheld (secret): {p}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
