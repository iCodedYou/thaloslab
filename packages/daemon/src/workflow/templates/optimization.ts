// Optimization workflow (SPEC §7): capture a baseline benchmark → surgical engineer change →
// benchmark-gated. The bench-gate runs a REAL baseline-vs-after measurement on top of the
// deterministic gates; a regression beyond tolerance fails the gate.
import type { WorkflowTemplate } from '@thaloslab/shared';

export const optimizationTemplate: WorkflowTemplate = {
  id: 'optimization',
  label: 'Optimization',
  appliesTo: ['optimization'],
  mutating: true,
  stages: [
    { id: 'baseline', role: 'engineer', produces: ['benchmark'], dependsOn: [] },
    {
      id: 'optimize',
      role: 'engineer',
      loop: { until: 'gates-green', retryCap: 3 },
      produces: ['diff'],
      dependsOn: ['baseline'],
    },
    { id: 'integrate', role: 'integrator', produces: ['diff'], dependsOn: ['optimize'] },
  ],
  gates: [
    {
      id: 'bench-gate',
      kind: 'automated',
      after: 'optimize',
      checks: ['build', 'typecheck', 'lint', 'unit', 'benchmark'],
      blocking: true,
    },
  ],
};
