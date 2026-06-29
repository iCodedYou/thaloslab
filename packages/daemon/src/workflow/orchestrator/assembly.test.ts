// Roster + gates are ASSEMBLED from triage data, not hardcoded per template: blast radius pulls in
// the security auditor + mandatory security/deploy gates; synthesized agents are clamped.
import type { AgentConfig } from '@thaloslab/shared';
import { describe, expect, it } from 'vitest';
import { allowedToolsFor, clampSynthesized } from '../roster/role-defaults';
import { selectTemplate } from '../templates';
import type { TriageResult } from '../triage';
import { assemble } from './assembly';

const base: Omit<TriageResult, 'taskType' | 'blastRadius'> = {
  mutating: true,
  signalQuality: 'objective',
  regressionSurface: 'low',
};

describe('assemble: data-driven roster + gate policy', () => {
  it('no blast radius → no security auditor, no security/deploy gates', () => {
    const triage: TriageResult = { ...base, taskType: 'bugfix', blastRadius: [] };
    const { roster, template } = assemble('p1', triage, selectTemplate('bugfix'));
    expect(roster.some((a) => a.role === 'security-auditor')).toBe(false);
    expect(template.gates.some((g) => g.id === 'security')).toBe(false);
    expect(template.gates.some((g) => g.id === 'deploy-signoff')).toBe(false);
    expect(roster.some((a) => a.role === 'orchestrator')).toBe(true);
  });

  it('blast radius (auth) → security auditor + mandatory security gate + blocking human deploy gate', () => {
    const triage: TriageResult = { ...base, taskType: 'bugfix', blastRadius: ['auth'] };
    const { roster, template, roleAgentId } = assemble('p1', triage, selectTemplate('bugfix'));

    const sec = roster.find((a) => a.role === 'security-auditor');
    expect(sec).toBeDefined();
    expect(roleAgentId['security-auditor']).toBe(sec?.id);

    const securityGate = template.gates.find((g) => g.id === 'security');
    expect(securityGate).toMatchObject({ kind: 'automated', blocking: true });
    expect(securityGate?.checks).toContain('security');

    const deploy = template.gates.find((g) => g.id === 'deploy-signoff');
    expect(deploy).toMatchObject({ kind: 'human', blocking: true });
    expect(deploy?.prompt).toContain('auth');
  });

  it('assigns a stable agentId per role (deterministic, so re-assembly upserts not duplicates)', () => {
    const triage: TriageResult = { ...base, taskType: 'bugfix', blastRadius: [] };
    const a = assemble('p1', triage, selectTemplate('bugfix'));
    const b = assemble('p1', triage, selectTemplate('bugfix'));
    expect(a.roleAgentId).toEqual(b.roleAgentId);
    expect(a.roleAgentId['engineer']).toBe('ag-p1-engineer');
  });
});

describe('no-silent-no-op: unimplemented specialist gate → blocking human gate', () => {
  it('converts a redesign visual-diff automated check into a human gate, keeping a11y automated', () => {
    const triage: TriageResult = { ...base, taskType: 'redesign', blastRadius: [] };
    const { template } = assemble('p1', triage, selectTemplate('redesign'));

    // The original visual-a11y automated gate no longer carries visual-diff…
    const automated = template.gates.find((g) => g.id === 'visual-a11y');
    expect(automated?.kind).toBe('automated');
    expect(automated?.checks).toContain('a11y');
    expect(automated?.checks).not.toContain('visual-diff');

    // …it became a blocking HUMAN gate that parks the ticket (never a silent green).
    const manual = template.gates.find((g) => g.id === 'visual-a11y-manual');
    expect(manual).toMatchObject({ kind: 'human', blocking: true, after: 'implement' });
    expect(manual?.prompt).toContain('visual-diff');
  });
});

describe('least-privilege clamp + tool derivation (the invoke chokepoint)', () => {
  const synthesized: AgentConfig = {
    id: 'x',
    projectId: 'p',
    role: 'custom',
    name: 'Perf Specialist',
    provider: 'claude',
    systemPrompt: '...',
    authority: 'L3-execute-autonomous',
    access: { pathScope: 'machine', network: 'full' },
    restrictedCommands: [],
    status: 'active',
    createdBy: 'orchestrator',
  };

  it('clamps a synthesized agent to L1 / network:none / own-worktree', () => {
    const c = clampSynthesized(synthesized);
    expect(c.authority).toBe('L1-propose');
    expect(c.access.network).toBe('none');
    expect(c.access.pathScope).toBe('own-worktree');
  });

  it('leaves a default (core) agent untouched', () => {
    const core = { ...synthesized, createdBy: 'default' as const };
    expect(clampSynthesized(core)).toEqual(core);
  });

  it('derives tools by role: engineer can run git, reviewer is read-only', () => {
    const eng = allowedToolsFor({ ...synthesized, role: 'engineer' });
    expect(eng).toContain('Bash(git *)');
    expect(allowedToolsFor({ ...synthesized, role: 'reviewer' })).toEqual(['Read']);
  });
});
