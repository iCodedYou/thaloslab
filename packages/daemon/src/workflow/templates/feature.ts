// New-feature workflow (SPEC §7): architect designs + decomposes → human signs off the design →
// parallel engineers (fan-out) build their seams → integrator merges. The plan-signoff sits AFTER
// the architect so the human approves the actual decomposition before engineers mobilize.
import type { WorkflowTemplate } from '@thaloslab/shared';

export const featureTemplate: WorkflowTemplate = {
  id: 'feature',
  label: 'New feature',
  appliesTo: ['feature'],
  mutating: true,
  stages: [
    {
      id: 'plan',
      role: 'architect',
      fanOut: { childRole: 'engineer', childStageId: 'impl', fromArtifact: 'plan', minChildren: 1 },
      produces: ['plan'],
      dependsOn: [],
    },
    { id: 'integrate', role: 'integrator', produces: ['diff'], dependsOn: ['impl'] },
  ],
  gates: [
    {
      id: 'plan-signoff',
      kind: 'human',
      after: 'plan',
      prompt: 'Approve the architecture + task decomposition before engineers build?',
      blocking: true,
    },
    {
      id: 'impl-green',
      kind: 'automated',
      after: 'impl',
      checks: ['build', 'typecheck', 'lint', 'unit'],
      blocking: true,
    },
    {
      id: 'integration-sweep',
      kind: 'automated',
      after: 'integrate',
      checks: ['unit'],
      blocking: true,
    },
  ],
};
