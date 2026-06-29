// Workflow template registry (data, not code — SPEC §7). Adding a template here is the only step
// needed to teach the engine a new workflow; the engine itself is template-agnostic.
import type { TaskType, WorkflowTemplate } from '@thaloslab/shared';
import { bugFixTemplate } from './bug-fix';
import { featureTemplate } from './feature';
import { optimizationTemplate } from './optimization';
import { redesignTemplate } from './redesign';
import { refactorTemplate } from './refactor';
import { securityAuditTemplate } from './security-audit';

const TEMPLATES: WorkflowTemplate[] = [
  bugFixTemplate,
  featureTemplate,
  securityAuditTemplate,
  optimizationTemplate,
  redesignTemplate,
  refactorTemplate,
];

export function allTemplates(): WorkflowTemplate[] {
  return TEMPLATES;
}

export function templateById(id: string): WorkflowTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

/** Map a triaged TaskType to a workflow template. Phase 1 defaults the long tail to bug-fix. */
export function selectTemplate(taskType: TaskType): WorkflowTemplate {
  return TEMPLATES.find((t) => t.appliesTo.includes(taskType)) ?? bugFixTemplate;
}

export {
  bugFixTemplate,
  featureTemplate,
  securityAuditTemplate,
  optimizationTemplate,
  redesignTemplate,
  refactorTemplate,
};
