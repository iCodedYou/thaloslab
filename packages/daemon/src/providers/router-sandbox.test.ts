// The router relaxation math (Phase 5). Proves the DECISION LOGIC: a constraint a CLI can't express
// is dropped from its unmet-set ONLY when a verified jail makes it moot for THIS run — and the hard
// asymmetry that a per-domain network allowlist is NEVER jail-satisfiable. Pure; no real jail.
import type {
  DetectedProvider,
  Sandbox,
  SandboxBinding,
  SandboxCapability,
  ToolPolicy,
} from '@thaloslab/shared';
import { describe, expect, it } from 'vitest';
import { enforceCodex } from './codex';
import { type RouterCtx, resolveForInvoke, sandboxSatisfies } from './router';
import { trustedCapabilities } from './sandbox';

const builderNetNone: ToolPolicy = {
  canRead: true,
  canWrite: true,
  canExecCommands: true,
  commandAllowlist: ['git *', 'pnpm *'],
  network: 'none',
  pathScope: 'own-worktree',
};
const builderAllowlist: ToolPolicy = {
  ...builderNetNone,
  network: 'allowlist',
  networkAllowlist: ['registry.npmjs.org'],
};

const codexOnly: DetectedProvider[] = [
  {
    id: 'codex',
    kind: 'local',
    displayName: 'Codex',
    installed: true,
    authenticated: true,
    lastChecked: 1,
  },
];

// A router ctx whose unmetFor mirrors the registry: codex's real enforce().unmet, minus what a
// verified sandbox with `caps` makes moot.
const ctx = (caps: SandboxCapability[]): RouterCtx => ({
  availability: codexOnly,
  preferenceOrder: ['claude', 'codex', 'gemini'],
  unmetFor: (_id, policy) => {
    const satisfied = sandboxSatisfies(policy, caps);
    return enforceCodex(policy).unmet.filter((u) => !satisfied.includes(u));
  },
});

describe('sandboxSatisfies — what a verified jail makes moot', () => {
  it('fs-scope + network-none makes the per-command allowlist moot (blast radius bounded at the OS)', () => {
    expect(sandboxSatisfies(builderNetNone, ['fs-scope', 'network-none'])).toEqual([
      'command-allowlist',
    ]);
  });
  it('NEVER satisfies network-allowlist — a jail cannot do per-domain filtering', () => {
    // command-allowlist is moot (fs confined), but network-allowlist is not in the output, ever.
    expect(sandboxSatisfies(builderAllowlist, ['fs-scope', 'network-none'])).not.toContain(
      'network-allowlist',
    );
  });
  it('no caps (unverified jail) satisfies NOTHING', () => {
    expect(sandboxSatisfies(builderNetNone, [])).toEqual([]);
  });
  it("pathScope 'machine' is not confinable → satisfies nothing", () => {
    expect(
      sandboxSatisfies({ ...builderNetNone, pathScope: 'machine' }, ['fs-scope', 'network-none']),
    ).toEqual([]);
  });
});

describe('the router relaxes ONLY when THIS run is verified-sandboxed', () => {
  it('a verified fs+network-none jail UN-PINS a Codex builder (network:none policy)', () => {
    expect(
      resolveForInvoke(ctx(['fs-scope', 'network-none']), {
        policy: builderNetNone,
        differ: 'none',
      }),
    ).toEqual({ kind: 'ok', provider: 'codex' });
  });

  it('WITHOUT a verified jail, the Codex builder stays incapable → PARK (Claude-pinned in practice)', () => {
    const r = resolveForInvoke(ctx([]), { policy: builderNetNone, differ: 'none' });
    expect(r.kind).toBe('park');
    if (r.kind === 'park') expect(r.reason).toContain('command-allowlist');
  });

  it('a network:allowlist builder stays PARKED even when sandboxed — the jail cannot enforce per-domain', () => {
    const r = resolveForInvoke(ctx(['fs-scope', 'network-none']), {
      policy: builderAllowlist,
      differ: 'none',
    });
    expect(r.kind).toBe('park');
    if (r.kind === 'park') expect(r.reason).toContain('network-allowlist');
  });
});

describe('trustedCapabilities — an unverified jail is trusted for nothing', () => {
  const handle: Sandbox = {
    id: 'noop',
    detect: async () => ({ available: true }),
    capabilities: () => ['fs-scope'],
    selfTest: async () => ({
      ok: true,
      fsBlocked: true,
      netBlocked: true,
      proof: '',
      id: 'noop',
      os: 'test',
      verifiedAt: 0,
    }),
    wrap: (cmd, args) => ({ cmd, args }),
  };
  const base: SandboxBinding = {
    handle,
    scope: { fsScope: { rw: [], hideRest: true }, network: 'none' },
    verified: true,
    requiredByRouter: false,
  };
  it('returns the caps only when the binding is verified', () => {
    expect(trustedCapabilities(base)).toEqual(['fs-scope']);
    expect(trustedCapabilities({ ...base, verified: false })).toEqual([]);
    expect(trustedCapabilities(undefined)).toEqual([]);
  });
});
