// The host-side collab provider adapter — `collab:<peerId>:<vendor>`. Its `invoke` is the host's half of
// the round-trip: pack a scoped (secret-stripped) context, persist the manifest BEFORE sending, push the
// invoke down the peer's socket, then treat the returned patch as UNTRUSTED DATA — apply it in
// quarantine, derive `changedFiles` from the HOST's own git, run the seam audit, and NEVER consume the
// peer's `ok`/`changedFiles`. The StageRunner then re-gates the worktree exactly as for any provider.
import type { InvokeOptions, ProviderAdapter, ProviderEvent, ProviderId } from '@thaloslab/shared';
import { genId } from '../util/id';
import { buildContextPack } from './context-pack';
import { persistManifest } from './manifest-store';
import { type Vendor, collabProviderId } from './protocol';
import { applyPeerPatch } from './quarantine';
import type { PeerLink } from './wire/peer-link';

export interface CollabAdapterOpts {
  /** Which of the peer's CLIs to invoke (the vendor's local id, e.g. 'codex'). */
  providerId: ProviderId;
  vendor: Vendor;
  /** Repo root for the manifest audit trail (host-side). */
  repoPath: string;
  /** The lane's seam (for the quarantine seam audit). Undefined ⇒ no seam restriction. */
  seamPaths?: string[];
  /** Files to pack (allowlist). Undefined ⇒ walk the worktree (minus deny-net). */
  packAllowlist?: string[];
  /** Injectable for deterministic tests (Date.now is unavailable in some contexts). */
  now?: () => number;
}

export function makeCollabAdapter(link: PeerLink, opts: CollabAdapterOpts): ProviderAdapter {
  const now = opts.now ?? (() => Date.now());
  return {
    id: collabProviderId(link.peerId, opts.vendor),
    displayName: `Collab peer ${link.peerId} (${opts.vendor})`,
    detect: () => Promise.resolve({ installed: true, authenticated: true }),
    capabilities: () => ({
      canEditFiles: true,
      canRunCommands: true,
      streaming: false,
      structuredOutput: true,
    }),
    // The neutral policy crosses as DATA; the peer re-derives + enforces on its side. Nothing unmet here.
    enforce: () => ({ args: [], unmet: [] }),
    async *invoke(invokeOpts: InvokeOptions): AsyncIterable<ProviderEvent> {
      const runId = genId('collabrun');
      // Axis 3: the pack is built HOST-SIDE, BEFORE the socket. A surviving secret THROWS here
      // (SecretLeakError) — the run fails and NOTHING crosses. Never warn-and-send.
      const pack = buildContextPack(
        invokeOpts.cwd,
        opts.packAllowlist ? { allowlist: opts.packAllowlist } : {},
      );
      // Inform: persist exactly what crossed BEFORE the push (the audit trail survives a dead socket).
      persistManifest(opts.repoPath, { runId, peerId: link.peerId, createdAt: now(), pack });

      // No credentials, no host cwd — only the neutral policy + the secret-stripped pack.
      const result = await link.invoke({
        policy: invokeOpts.policy,
        providerId: opts.providerId,
        prompt: invokeOpts.prompt,
        contextManifest: pack.manifest,
        files: pack.files,
      });

      // Axis 2: the peer's `ok`/`changedFiles` are UNTRUSTED. Apply in quarantine, derive changedFiles
      // from the HOST's git, run the seam audit. An out-of-seam write ⇒ ok:false.
      const verdict = await applyPeerPatch(invokeOpts.cwd, result, opts.seamPaths);
      yield {
        type: 'result',
        result: {
          ok: verdict.seamViolation.length === 0,
          output: result.output,
          artifacts: [],
          changedFiles: verdict.changedFiles, // HOST-derived, never result.changedFiles
          usage: result.usage,
          raw: {
            collab: { peerId: link.peerId, seamViolation: verdict.seamViolation },
            // The peer's self-report is recorded for debugging but NEVER consumed as truth.
            peerSelfReport: { ok: result.ok, changedFiles: result.changedFiles },
          },
        },
      };
    },
  };
}
