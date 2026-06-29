// The cross-provider router (SPEC §5). A PURE function of (availability, preference order, the
// per-provider enforce results, role differ-rule). The engine never picks a provider — it asks the
// router. Selection is CONSTRAINT-AWARE and FAIL-CLOSED: a provider that cannot enforce the role's
// required least-privilege policy is ineligible (never "run it anyway"); if nothing eligible
// remains, the caller PARKS/escalates — containment is never silently reduced.
import type {
  DetectedProvider,
  ProviderId,
  SandboxCapability,
  ToolPolicy,
} from '@thaloslab/shared';

/** Per-role differ-rule: reviewer MUST differ from the engineer's provider; auditor PREFERs to. */
export type Differ = 'must' | 'prefer' | 'none';

/**
 * The underlying VENDOR of a provider id. Collab provider ids are `collab:<peerId>:<vendor>` so the
 * reviewer-differs rule can compare the VENDOR, not the provider-id — otherwise a `collab:peerB:codex`
 * reviewing a LOCAL `codex` engineer would pass the differ check (different id) while sharing the same
 * vendor's blind spots (the whole point of adversarial independence is defeated).
 */
export function vendorOf(providerId: ProviderId): string {
  if (providerId.startsWith('collab:')) {
    const parts = providerId.split(':');
    return parts[2] ?? parts[1] ?? providerId; // the vendor segment
  }
  return providerId;
}

/**
 * Constraints a VERIFIED sandbox makes moot for THIS invocation (Phase 5). The per-command allowlist's
 * PURPOSE is blast-radius containment; a verified fs-scope (+ network-none when the policy wants none)
 * jail delivers that radius at the OS level → the per-command rule is moot. This is NOT "the CLI now
 * expresses the allowlist" — it's "a stronger layer enforces what the allowlist was protecting".
 *
 * Hard asymmetry: a jail CANNOT do per-domain filtering, so `network-allowlist` is NEVER returned here.
 * Only `network:'none'` is jail-enforceable; a `network:'allowlist'` policy keeps that unmet, sandboxed
 * or not. Caps MUST already be filtered to a passed self-test (an unverified jail satisfies nothing).
 */
export function sandboxSatisfies(policy: ToolPolicy, caps: SandboxCapability[]): string[] {
  const fsConfined = caps.includes('fs-scope') && policy.pathScope !== 'machine';
  const networkHandled = policy.network !== 'none' || caps.includes('network-none');
  return fsConfined && networkHandled ? ['command-allowlist'] : [];
}

export type Resolution =
  | { kind: 'ok'; provider: ProviderId; degraded?: 'same-provider-fresh-context' }
  | { kind: 'park'; reason: string };

export interface RouterCtx {
  availability: DetectedProvider[];
  /** Preference order (Project.routingPolicy; defaults to detection order). */
  preferenceOrder: ProviderId[];
  /** Constraints a provider CANNOT enforce for this policy (already minus `relaxable`). Empty ⇒ capable. */
  unmetFor: (id: ProviderId, policy: ToolPolicy) => string[];
}

function rank(order: ProviderId[], id: ProviderId): number {
  const i = order.indexOf(id);
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}

/** installed + authenticated + can-enforce-the-policy providers, in preference order. */
function capable(ctx: RouterCtx, policy: ToolPolicy): ProviderId[] {
  return ctx.availability
    .filter((p) => p.installed && p.authenticated)
    .map((p) => p.id)
    .filter((id) => ctx.unmetFor(id, policy).length === 0)
    .sort((a, b) => rank(ctx.preferenceOrder, a) - rank(ctx.preferenceOrder, b));
}

/** Assembly-time: the preferred concrete provider for an agent's policy (null if none capable). */
export function assignProvider(ctx: RouterCtx, policy: ToolPolicy): ProviderId | null {
  return capable(ctx, policy)[0] ?? null;
}

/**
 * Invoke-time: the final provider, with differ-enforcement + fail-closed.
 *   capable + different available → use it
 *   only the avoided provider is capable (differ=must) → degrade to same-provider-fresh-context
 *   nothing capable → PARK (never run unconstrained)
 */
export function resolveForInvoke(
  ctx: RouterCtx,
  args: { policy: ToolPolicy; avoidProvider?: ProviderId; differ: Differ },
): Resolution {
  const caps = capable(ctx, args.policy);
  if (caps.length === 0) {
    const detail = ctx.availability
      .filter((p) => p.installed && p.authenticated)
      .map((p) => `${p.id}:[${ctx.unmetFor(p.id, args.policy).join(',') || 'ok'}]`)
      .join(' ');
    return {
      kind: 'park',
      reason: `no installed provider can enforce the required policy — ${detail || 'no providers installed/authenticated'}`,
    };
  }
  const primary = caps[0] as ProviderId;
  if (args.differ === 'none' || !args.avoidProvider) return { kind: 'ok', provider: primary };

  // Differ by VENDOR, not provider-id: a collab peer running the same vendor is NOT a valid differ.
  const avoidVendor = vendorOf(args.avoidProvider);
  const different = caps.filter((id) => vendorOf(id) !== avoidVendor);
  if (different.length > 0) return { kind: 'ok', provider: different[0] as ProviderId };

  // Only the engineer's vendor is capable.
  if (args.differ === 'must') {
    return { kind: 'ok', provider: args.avoidProvider, degraded: 'same-provider-fresh-context' };
  }
  return { kind: 'ok', provider: primary };
}
