// Refactor workflow (SPEC §7): architect plans the restructure + decomposition → human sign-off →
// parallel engineers → adversarial review (behavior must stay identical) → integrate. The
// characterization gate (build/type/lint/unit) is the equivalence backstop.
import type { WorkflowTemplate } from '@thaloslab/shared';

export const refactorTemplate: WorkflowTemplate = {
  id: 'refactor',
  label: 'Refactor',
  appliesTo: ['refactor'],
  mutating: true,
  stages: [
    {
      id: 'plan',
      role: 'architect',
      fanOut: { childRole: 'engineer', childStageId: 'impl', fromArtifact: 'plan', minChildren: 1 },
      produces: ['plan'],
      dependsOn: [],
    },
    { id: 'review', role: 'reviewer', produces: ['review'], dependsOn: ['impl'] },
    { id: 'integrate', role: 'integrator', produces: ['diff'], dependsOn: ['review'] },
  ],
  gates: [
    {
      id: 'plan-signoff',
      kind: 'human',
      after: 'plan',
      prompt: 'Approve the refactor plan (behavior must stay identical)?',
      blocking: true,
    },
    {
      id: 'characterization',
      kind: 'automated',
      after: 'impl',
      checks: ['build', 'typecheck', 'lint', 'unit'],
      blocking: true,
    },
    { id: 'pre-merge', kind: 'automated', after: 'review', checks: ['unit'], blocking: true },
  ],
};
