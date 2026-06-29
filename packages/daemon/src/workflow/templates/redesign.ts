// Frontend-redesign workflow (SPEC §7): design direction (human sign-off) → implement → visual +
// a11y gates. The a11y check is REAL (rule-based); visual-diff has no automated implementation, so
// assembly converts it to a blocking HUMAN gate — it must never pass silently.
import type { WorkflowTemplate } from '@thaloslab/shared';

export const redesignTemplate: WorkflowTemplate = {
  id: 'redesign',
  label: 'Frontend redesign',
  appliesTo: ['redesign'],
  mutating: true,
  stages: [
    { id: 'design', role: 'architect', produces: ['plan'], dependsOn: ['design-signoff'] },
    {
      id: 'implement',
      role: 'engineer',
      loop: { until: 'gates-green', retryCap: 3 },
      produces: ['diff'],
      dependsOn: ['design'],
    },
    { id: 'integrate', role: 'integrator', produces: ['diff'], dependsOn: ['implement'] },
  ],
  gates: [
    {
      id: 'design-signoff',
      kind: 'human',
      after: '',
      prompt: 'Approve the design direction?',
      blocking: true,
    },
    {
      id: 'visual-a11y',
      kind: 'automated',
      after: 'implement',
      checks: ['build', 'typecheck', 'a11y', 'visual-diff'],
      blocking: true,
    },
  ],
};
