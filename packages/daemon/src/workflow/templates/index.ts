// Workflow template registry (data, not code — SPEC §7). Phase 1 ships the bug-fix template; later
// phases add feature/security/optimization/redesign/refactor here without touching the engine.
import type { TaskType, WorkflowTemplate } from '@thaloslab/shared';
import { bugFixTemplate } from './bug-fix';

const TEMPLATES: WorkflowTemplate[] = [bugFixTemplate];

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

export { bugFixTemplate };
