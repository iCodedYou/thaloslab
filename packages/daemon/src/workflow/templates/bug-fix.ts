// The Phase 1 bug-fix workflow as DATA (SPEC §7): reproduction-test-first → fix (looped) →
// adversarial review → regression sweep → integrate. The human plan sign-off gates the whole
// plan (empty `after` → ready immediately, parks before any mutating stage). Automated gates are
// metadata the production StageRunner reads to know which checks to run after each stage.
import type { WorkflowTemplate } from '@thaloslab/shared';

export const bugFixTemplate: WorkflowTemplate = {
  id: 'bug-fix',
  label: 'Bug fix',
  appliesTo: ['bugfix'],
  mutating: true,
  stages: [
    { id: 'repro', role: 'test-author', produces: ['repro-test'], dependsOn: ['plan-signoff'] },
    {
      id: 'fix',
      role: 'engineer',
      loop: { until: 'gates-green', retryCap: 3 },
      produces: ['diff'],
      dependsOn: ['repro'],
    },
    { id: 'review', role: 'reviewer', produces: ['review'], dependsOn: ['fix'] },
    { id: 'regression', role: 'integrator', produces: ['test-results'], dependsOn: ['review'] },
    { id: 'integrate', role: 'integrator', produces: ['diff'], dependsOn: ['regression'] },
  ],
  gates: [
    {
      id: 'plan-signoff',
      kind: 'human',
      after: '',
      prompt: 'Approve the plan before execution?',
      blocking: true,
    },
    { id: 'repro-red', kind: 'automated', after: 'repro', checks: ['unit'], blocking: true },
    {
      id: 'fix-green',
      kind: 'automated',
      after: 'fix',
      checks: ['build', 'typecheck', 'lint', 'unit'],
      blocking: true,
    },
    {
      id: 'regression-sweep',
      kind: 'automated',
      after: 'regression',
      checks: ['unit'],
      blocking: true,
    },
  ],
};
