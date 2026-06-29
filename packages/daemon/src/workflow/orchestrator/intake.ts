// Orchestrator intake (SPEC §8). The deterministic driver: classify the ticket, select the
// template, create the ticket (which renders the plan-of-attack message + DAG), persist the
// triage, and — unless preview — advance the engine. The typed OrchestratorMessage stream is
// rendered by the engine as state transitions occur.
import type { ExecutionMode, Ticket } from '@thaloslab/shared';
import { getTicket, updateTicketTriage } from '../../store/repositories/tickets';
import type { Engine } from '../engine';
import { selectTemplate } from '../templates';
import { type Classifier, classifyTicket } from '../triage';

export interface IntakeRequest {
  projectId: string;
  title: string;
  body?: string;
  mode: ExecutionMode;
}

export async function intakeTicket(
  engine: Engine,
  req: IntakeRequest,
  classifier?: Classifier,
): Promise<Ticket> {
  const triage = await classifyTicket(req.title, req.body ?? '', classifier);
  const template = selectTemplate(triage.taskType);

  const ticket = engine.createTicketFromTemplate({
    projectId: req.projectId,
    title: req.title,
    body: req.body,
    template,
    mode: req.mode,
  });

  updateTicketTriage(ticket.id, {
    taskType: triage.taskType,
    mutating: triage.mutating,
    blastRadius: triage.blastRadius,
    workflowId: template.id,
  });

  if (req.mode !== 'preview') await engine.advance(ticket.id);
  // Return the latest persisted ticket (reflects triage + any advance-driven status change).
  return getTicket(ticket.id) ?? ticket;
}
