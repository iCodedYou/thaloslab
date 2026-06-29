// Greenfield MVP workflow (SPEC §7, Phase 4). Builds a project from (almost) nothing: a from-scratch
// repo starts as a README commit on `main`; the architect FILLS it. Chosen by project PHASE
// (bootstrapping), not by triage keywords — see orchestrator/intake.ts.
//
// Ordering matters and is load-bearing:
//   spec               the architect produces a DURABLE spec (scope, entities, non-goals, and
//                      TESTABLE acceptance criteria — "MVP exists" is defined here) + designed seams.
//   [spec-signoff]     human approves the spec + boundaries BEFORE any scaffolding effort. The gate's
//                      job includes "are these acceptance criteria concrete enough to test?".
//   scaffold           an engineer materializes package.json (build/typecheck/lint/test) + the src/
//                      skeleton + interface-contract stubs + the spec's acceptance criteria as RED
//                      tests, and commits the durable spec as a tracked file. Gate omits `unit`: the
//                      suite is RED by design here, so gating on it would deadlock.
//   scaffold-integrate the EXISTING integrator merges the scaffold lane onto thalos/integration, so
//                      the impl lanes (which branch off integration) inherit the toolchain + skeleton.
//                      Its own works-alone sweep is a no-op on this pass (integration carried no
//                      package.json before the merge → no `unit` baseline to run).
//   decompose          the architect fans out over the now-REAL directories (disjointness + ownership
//                      are checkable because the seams physically exist).
//   impl (fan-out)     one engineer per seam fills its module, turning its RED acceptance tests GREEN.
//                      impl-green is ABSOLUTE (build/typecheck/lint/unit) and has teeth — a red/empty
//                      suite can't pass (the greenfield analog of repro-red).
//   integrate          the integrator merges the impl lanes; integration-sweep runs the now-GREEN suite
//                      (the baseline is BORN — ticket #2 gets the Phase 1-3 differential machinery back).
//   [pre-ship]         human signs off the MVP. The workflow ends on thalos/integration; `main` is
//                      NEVER auto-landed (no greenfield exception — landing is a separate human action).
import type { WorkflowTemplate } from '@thaloslab/shared';

export const greenfieldTemplate: WorkflowTemplate = {
  id: 'greenfield',
  label: 'Greenfield MVP',
  appliesTo: ['greenfield'],
  mutating: true,
  stages: [
    { id: 'spec', role: 'architect', produces: ['spec'], dependsOn: [] },
    { id: 'scaffold', role: 'engineer', produces: ['diff'], dependsOn: ['spec'] },
    { id: 'scaffold-integrate', role: 'integrator', produces: ['diff'], dependsOn: ['scaffold'] },
    {
      id: 'decompose',
      role: 'architect',
      fanOut: { childRole: 'engineer', childStageId: 'impl', fromArtifact: 'plan', minChildren: 1 },
      produces: ['plan'],
      dependsOn: ['scaffold-integrate'],
    },
    { id: 'integrate', role: 'integrator', produces: ['diff'], dependsOn: ['impl'] },
  ],
  gates: [
    {
      id: 'spec-signoff',
      kind: 'human',
      after: 'spec',
      prompt:
        'Approve the spec, the module boundaries, and that the acceptance criteria are concrete enough to test — before scaffolding?',
      blocking: true,
    },
    {
      id: 'scaffold-green',
      kind: 'automated',
      after: 'scaffold',
      // No `unit`: the acceptance suite is RED by design until engineers implement. This proves only
      // that the toolchain itself works.
      checks: ['build', 'typecheck', 'lint'],
      blocking: true,
    },
    {
      id: 'impl-green',
      kind: 'automated',
      after: 'impl',
      // ABSOLUTE: the seam's acceptance tests must PASS (build green + suite green from zero).
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
    {
      // Mandatory security audit on the integrated MVP. Placed explicitly here (after the FINAL
      // integrate) rather than via assembly's blast-radius injection, which targets the first
      // integrator — `scaffold-integrate`, mid-workflow — and would scan an empty skeleton.
      id: 'security',
      kind: 'automated',
      after: 'integrate',
      checks: ['security'],
      blocking: true,
    },
    {
      id: 'pre-ship',
      kind: 'human',
      after: 'integrate',
      prompt: 'Approve the MVP? (build phase complete; the spec acceptance criteria are met)',
      blocking: true,
    },
  ],
};
