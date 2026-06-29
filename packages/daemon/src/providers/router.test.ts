// The constraint-aware router (SPEC §5). Pure — injected availability + enforce results. Proves the
// reviewer-differs rule, graceful degradation, preference determinism, and — the safety invariant —
// that an unenforceable least-privilege constraint actually FAILS CLOSED (parks), never runs.
import type { DetectedProvider, ProviderId, ToolPolicy } from '@thaloslab/shared';
import { describe, expect, it } from 'vitest';
import { type RouterCtx, assignProvider, resolveForInvoke } from './router';

const avail = (...ids: ProviderId[]): DetectedProvider[] =>
  ids.map((id) => ({
    id,
    kind: 'local',
    displayName: id,
    installed: true,
    authenticated: true,
    lastChecked: 1,
  }));

const ctx = (over: Partial<RouterCtx>): RouterCtx => ({
  availability: avail('claude', 'codex'),
  preferenceOrder: ['claude', 'codex', 'gemini'],
  unmetFor: () => [],
  ...over,
});

const policy: ToolPolicy = {
  canRead: true,
  canWrite: false,
  canExecCommands: false,
  network: 'none',
  pathScope: 'own-worktree',
};

describe('reviewer-differs routing', () => {
  it('routes the reviewer to a DIFFERENT provider when two are capable', () => {
    expect(resolveForInvoke(ctx({}), { policy, avoidProvider: 'claude', differ: 'must' })).toEqual({
      kind: 'ok',
      provider: 'codex',
    });
  });

  it('degrades to same-provider-fresh-context when only the avoided provider is capable (differ=must)', () => {
    expect(
      resolveForInvoke(ctx({ availability: avail('claude') }), {
        policy,
        avoidProvider: 'claude',
        differ: 'must',
      }),
    ).toEqual({ kind: 'ok', provider: 'claude', degraded: 'same-provider-fresh-context' });
  });

  it('prefer (auditor) uses the primary even if it equals the avoided', () => {
    expect(
      resolveForInvoke(ctx({ availability: avail('claude') }), {
        policy,
        avoidProvider: 'claude',
        differ: 'prefer',
      }),
    ).toEqual({ kind: 'ok', provider: 'claude' });
  });

  it('respects the preference order (not availability order)', () => {
    expect(
      resolveForInvoke(ctx({ availability: avail('gemini', 'codex', 'claude') }), {
        policy,
        differ: 'none',
      }),
    ).toEqual({ kind: 'ok', provider: 'claude' });
  });
});

describe('fail-closed (the safety invariant)', () => {
  it('PARKS when no installed provider can enforce the required policy', () => {
    const r = resolveForInvoke(ctx({ unmetFor: () => ['command-allowlist'] }), {
      policy,
      differ: 'none',
    });
    expect(r.kind).toBe('park');
    if (r.kind === 'park') expect(r.reason).toContain('command-allowlist');
  });

  it('PARKS when no providers are installed/authenticated', () => {
    expect(resolveForInvoke(ctx({ availability: [] }), { policy, differ: 'none' }).kind).toBe(
      'park',
    );
  });

  it('filters out an INCAPABLE provider, never routes to it — must-differ then degrades to the capable one', () => {
    // codex can't enforce the constraint → ineligible; only claude is capable.
    const unmetFor = (id: ProviderId) => (id === 'codex' ? ['network-none'] : []);
    expect(
      resolveForInvoke(ctx({ unmetFor }), { policy, avoidProvider: 'claude', differ: 'must' }),
    ).toEqual({ kind: 'ok', provider: 'claude', degraded: 'same-provider-fresh-context' });
  });
});

describe('assignProvider (assembly-time preferred provider)', () => {
  it('picks the top capable provider, or null when none can enforce', () => {
    expect(assignProvider(ctx({}), policy)).toBe('claude');
    expect(assignProvider(ctx({ unmetFor: () => ['x'] }), policy)).toBeNull();
  });
});
