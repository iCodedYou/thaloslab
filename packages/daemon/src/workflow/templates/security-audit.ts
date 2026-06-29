// Security-audit workflow (SPEC §7): READ-ONLY — threat-model recon → focused audit, producing a
// findings report. No build/integrate/merge back half (mutating: false). The security-scan gate
// runs a REAL scan (deps + secrets + dangerous patterns); a human triages findings before any
// remediation is authorized.
import type { WorkflowTemplate } from '@thaloslab/shared';

export const securityAuditTemplate: WorkflowTemplate = {
  id: 'security-audit',
  label: 'Security audit',
  appliesTo: ['security-audit'],
  mutating: false,
  stages: [
    { id: 'recon', role: 'security-auditor', produces: ['threat-model'], dependsOn: [] },
    { id: 'audit', role: 'security-auditor', produces: ['findings'], dependsOn: ['recon'] },
  ],
  gates: [
    {
      id: 'security-scan',
      kind: 'automated',
      after: 'audit',
      checks: ['security'],
      blocking: true,
    },
    {
      id: 'findings-triage',
      kind: 'human',
      after: 'audit',
      prompt: 'Review findings + severity; approve before any remediation?',
      blocking: true,
    },
  ],
};
