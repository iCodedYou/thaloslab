// Roster + gate assembly (SPEC §7). Pure: triage + template → { template (with policy-injected
// gates), roster (AgentConfigs), role→agentId }. The roster is NOT hardcoded per template — it is
// the template's roles plus policy additions driven by triage axes (blast radius → security pass +
// human deploy gate). Synthesized agents are clamped to least-privilege here (and re-clamped at the
// invoke chokepoint).
import type { AgentConfig, AgentRole, GateDef, WorkflowTemplate } from '@thaloslab/shared';
import { agentFromRole, clampSynthesized } from '../roster/role-defaults';
import type { TriageResult } from '../triage';

export interface Assembly {
  template: WorkflowTemplate;
  roster: AgentConfig[];
  /** stage role → agentId, for assigning task.agentId at materialization. */
  roleAgentId: Record<string, string>;
}

const ROLE_NAME: Record<AgentRole, string> = {
  orchestrator: 'Orchestrator',
  architect: 'Architect',
  engineer: 'Engineer',
  reviewer: 'Reviewer',
  'test-author': 'Test Author',
  'security-auditor': 'Security Auditor',
  integrator: 'Integrator',
  custom: 'Specialist',
};

export function assemble(
  projectId: string,
  triage: TriageResult,
  template: WorkflowTemplate,
): Assembly {
  const roles = new Set<AgentRole>(['orchestrator']);
  for (const s of template.stages) if (s.role !== 'custom') roles.add(s.role);

  const sensitive = triage.blastRadius.length > 0;
  if (sensitive) roles.add('security-auditor');

  const roster: AgentConfig[] = [];
  const roleAgentId: Record<string, string> = {};
  for (const role of roles) {
    const id = `ag-${projectId}-${role}`;
    const agent = clampSynthesized(agentFromRole({ id, projectId, role, name: ROLE_NAME[role] }));
    roster.push(agent);
    roleAgentId[role] = id;
  }

  // Policy gate injection from blast radius (the consumer triage.blastRadius was built for).
  let assembled = template;
  if (sensitive) {
    const buildStageId =
      template.stages.find((s) => s.role === 'engineer')?.id ??
      template.stages.at(-1)?.id ??
      template.stages[0]?.id ??
      '';
    const integrateStageId = template.stages.find((s) => s.role === 'integrator')?.id;
    const extraGates: GateDef[] = [
      {
        id: 'security',
        kind: 'automated',
        after: buildStageId,
        checks: ['security'],
        blocking: true,
      },
      {
        id: 'deploy-signoff',
        kind: 'human',
        after: integrateStageId ?? buildStageId,
        prompt: `Risky change (blast radius: ${triage.blastRadius.join(', ')}). Approve before deploy?`,
        blocking: true,
      },
    ];
    assembled = { ...template, gates: [...template.gates, ...extraGates] };
  }

  return { template: assembled, roster, roleAgentId };
}
