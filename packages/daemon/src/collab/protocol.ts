// The host↔peer RPC contract (SPEC §11). The real cross-machine wire is DEFERRED-PENDING-MULTI-MACHINE;
// the in-process mock peer (peer-mock.ts) speaks this same contract so the trust LOGIC is proven
// deterministically. KEY invariants encoded here: the invoke carries the neutral ToolPolicy + a
// context manifest, NEVER credentials or a host path; the peer's `ok`/`changedFiles` are ADVISORY
// (the host derives the truth from its own git); a peer with no verified sandbox is unroutable.
import type { InvokeUsage, ProviderId, SelfTestResult, ToolPolicy } from '@thaloslab/shared';
import type { ManifestEntry } from './context-pack';

export type Vendor = 'claude' | 'codex' | 'gemini';

/** A peer's advertisement on connect. `sandbox` is the peer's OWN self-test result — null or !ok ⇒
 *  the host must REFUSE to route pooled work there (collab is sandbox-required, fail-closed). */
export interface PeerHello {
  peerId: string;
  cliProviders: { id: ProviderId; vendor: Vendor; version?: string; authenticated: boolean }[];
  sandbox: SelfTestResult | null;
}

/** Host→peer invocation. No credentials. No host cwd. The manifest is exactly what crossed. */
export interface PeerInvokeRequest {
  policy: ToolPolicy;
  providerId: ProviderId; // which of the peer's CLIs
  prompt: string;
  contextManifest: ManifestEntry[];
  files: { path: string; content: string }[]; // the pack contents (already secret-stripped)
}

/** Peer→host result. `ok` and `changedFiles` are ADVISORY — the host re-derives both. The patch is a
 *  write-set here (the real wire carries a unified diff applied via `git apply`). */
export interface PeerResult {
  ok: boolean;
  output: string;
  patch: Record<string, string>; // path → new content
  changedFiles: string[]; // advisory; the host ignores this
  usage?: InvokeUsage;
}

/** `collab:<peerId>:<vendor>` — the provider id form that lets the router recover the vendor for the
 *  reviewer-differs-by-vendor rule. */
export function collabProviderId(peerId: string, vendor: Vendor): ProviderId {
  return `collab:${peerId}:${vendor}`;
}

/** Collab is sandbox-REQUIRED: a peer is routable ONLY if its advertised self-test PASSED. A null or
 *  failed self-test ⇒ the host refuses (the peer can't protect itself from the host's task). */
export function peerRoutable(hello: PeerHello): boolean {
  return hello.sandbox?.ok === true;
}
