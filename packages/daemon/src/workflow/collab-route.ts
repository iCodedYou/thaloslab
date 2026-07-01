// The collab-DISPATCH decision (G0) — the FAIL-CLOSED gate that decides whether a task's explicit provider
// target routes to a remote collab peer. PURE + deterministic (deps injected) so every PARK branch is
// unit-testable and mutation-provable. Dispatch is EXPLICIT-and-gated ONLY: a task reaches a peer solely
// when the project opted in AND the task names a specific, currently-routable peer AND (for a differ:'must'
// role) its vendor differs from the engineer's. Anything else PARKS — NEVER a silent fall-back to a local
// provider, and an 'auto'/local target is NEVER a collab pick (a collab adapter's enforce() has nothing
// unmet, so it is always "capable" — it must never enter automatic routing, only explicit dispatch).
import type { Project, ProviderId } from '@thaloslab/shared';
import { type Differ, vendorOf } from '../providers/router';

export type CollabRoute =
  | { kind: 'local' } // not a collab target → take the normal (local) router path
  | { kind: 'collab'; peerId: string; vendor: string; providerId: ProviderId }
  | { kind: 'park'; reason: string };

export interface CollabRouteDeps {
  /** PROJECT gate (coarse): collab dispatch is enabled for this project. Default OFF. */
  collabEnabled: boolean;
  /** FINE gate: is this peer routable RIGHT NOW (admitted + sandbox-verified + collab active)? */
  isRoutable: (peerId: string) => boolean;
}

/** The project's collab-dispatch opt-in — default OFF. Lives on the flexible `routingPolicy` bag so no
 *  schema change is needed; a project with `routingPolicy.collab === true` may dispatch to a peer. */
export function projectCollabEnabled(project: Project | null | undefined): boolean {
  return project?.routingPolicy?.collab === true;
}

/** Well-formed `collab:<peerId>:<vendor>` (both segments non-empty) — the single source of the target-id
 *  format, used by `resolveCollabRoute` and validated at config time (the routing-policy PATCH). */
export function isCollabProviderId(id: unknown): id is ProviderId {
  if (typeof id !== 'string' || !id.startsWith('collab:')) return false;
  const [, peerId, vendor] = id.split(':');
  return Boolean(peerId) && Boolean(vendor);
}

/**
 * Decide a task's collab routing. Returns `local` for any non-collab target (so `'auto'` and local
 * provider ids NEVER dispatch remote), `collab` only when both gates pass and the differ-by-vendor rule
 * holds, and `park` (fail closed) otherwise.
 */
export function resolveCollabRoute(
  agentProvider: string,
  differ: Differ,
  avoidProvider: ProviderId | undefined,
  deps: CollabRouteDeps,
): CollabRoute {
  // 'auto' / a local provider id ⇒ NEVER collab. No automatic/implicit remote routing.
  if (!agentProvider.startsWith('collab:')) return { kind: 'local' };

  const [, peerId, vendor] = agentProvider.split(':');
  if (!peerId || !vendor) {
    return { kind: 'park', reason: `malformed collab target "${agentProvider}"` };
  }
  const providerId = agentProvider as ProviderId;

  // PROJECT gate — off by default; a target for a non-opted-in project never dispatches.
  if (!deps.collabEnabled) {
    return {
      kind: 'park',
      reason: 'collab dispatch not enabled for this project (routingPolicy.collab)',
    };
  }
  // FINE gate — the named peer must be routable RIGHT NOW; else fail closed (NO local fall-back).
  if (!deps.isRoutable(peerId)) {
    return {
      kind: 'park',
      reason: `collab peer "${peerId}" is not routable (not admitted / verified / active)`,
    };
  }
  // Reviewer-differs by VENDOR: a collab peer running the engineer's vendor is not a valid adversary.
  if (differ === 'must' && avoidProvider && vendorOf(providerId) === vendorOf(avoidProvider)) {
    return {
      kind: 'park',
      reason: `collab reviewer vendor "${vendor}" equals the engineer's — differ violated`,
    };
  }
  return { kind: 'collab', peerId, vendor, providerId };
}
