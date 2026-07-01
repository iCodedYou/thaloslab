// Orchestrator intake (SPEC §8). The deterministic driver: classify the ticket, select the
// template, create the ticket (which renders the plan-of-attack message + DAG), persist the
// triage, and — unless preview — advance the engine. The typed OrchestratorMessage stream is
// rendered by the engine as state transitions occur.
import type { ExecutionMode, Ticket, TicketStatus } from '@thaloslab/shared';
import { routerCtx } from '../../providers/registry';
import { assignProvider } from '../../providers/router';
import { upsertAgent, writeAgentFile } from '../../store/repositories/agents';
import { getProject } from '../../store/repositories/projects';
import { getTicket, listTickets, updateTicketTriage } from '../../store/repositories/tickets';
import { projectCollabEnabled, projectCollabTargets } from '../collab-route';
import type { Engine } from '../engine';
import { policyFor } from '../roster/role-defaults';
import { greenfieldTemplate, selectTemplate } from '../templates';
import { type Classifier, classifyTicket } from '../triage';
import { assemble } from './assembly';

const TERMINAL_TICKET: TicketStatus[] = [
  'done',
  'failed',
  'escalated',
  'aborted',
  'preview-complete',
];

/** A from-scratch project still needs its MVP iff it's in `bootstrapping` AND no greenfield ticket
 *  has reached terminal `done`. Bound to *completed* (not merely existing) so a failed/escalated
 *  first attempt re-enters greenfield rather than being stranded in maintenance against no baseline. */
function greenfieldNeeded(projectId: string, phase: string | undefined): boolean {
  if (phase !== 'bootstrapping') return false;
  return !listTickets(projectId).some((t) => t.workflowId === 'greenfield' && t.status === 'done');
}

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

  // Greenfield is chosen by project PHASE, not by triage keywords (triage still runs — its blast
  // radius drives the security-audit injection, which a greenfield MVP must always carry). The first
  // ticket on a bootstrapping project IS the MVP build.
  const project = getProject(req.projectId);
  const useGreenfield = greenfieldNeeded(req.projectId, project?.phase);
  if (useGreenfield) {
    // One MVP build at a time: reject a second ticket while a greenfield ticket is still in flight.
    const inflight = listTickets(req.projectId).some(
      (t) => t.workflowId === 'greenfield' && !TERMINAL_TICKET.includes(t.status),
    );
    if (inflight) {
      throw new Error('a greenfield MVP build is already in progress for this project');
    }
  }
  const baseTemplate = useGreenfield ? greenfieldTemplate : selectTemplate(triage.taskType);

  // Data-driven assembly: triage → roster + policy-injected gates + role→agentId. Greenfield carries
  // its OWN correctly-placed security + pre-ship gates (the template), so we suppress assembly's
  // blast-radius gate injection for it — that injection targets the FIRST engineer/integrator stage,
  // which in greenfield is the scaffold / scaffold-integrate (mid-workflow), not the final build.
  const assemblyTriage = useGreenfield ? { ...triage, blastRadius: [] } : triage;
  const { template, roster, roleAgentId } = assemble(req.projectId, assemblyTriage, baseTemplate);

  // Persist the assembled roster (DB index + git-tracked .thalos/agents mirror). Resolve each
  // agent's 'auto' provider to a concrete PREFERRED provider via the router (the invoke-time
  // resolution re-checks + enforces the reviewer-differs rule against the engineer's actual run).
  //
  // Collab BORN-targeting: when the project opted in (`routingPolicy.collab`), an agent whose ROLE has a
  // collab target is BORN with `provider=collab:<peer>:<vendor>` HERE, at assembly — never a mid-flight
  // retarget (that was racy). Fan-out engineer lanes all share this one engineer agent (`roleAgentId`),
  // so every lane inherits the target with no race. This only PRODUCES the target the G0 dispatch gate
  // consumes — the gate still checks routability LIVE (an offline-peer target PARKS at run time).
  const repoPath = project?.repoPath;
  const ctx = routerCtx(req.projectId);
  const collabTargets = projectCollabEnabled(project) ? projectCollabTargets(project) : {};
  for (const agent of roster) {
    const provider =
      collabTargets[agent.role] ?? assignProvider(ctx, policyFor(agent)) ?? undefined;
    const withProvider = provider ? { ...agent, provider } : agent;
    upsertAgent(withProvider);
    if (repoPath) writeAgentFile(repoPath, withProvider);
  }

  const ticket = engine.createTicketFromTemplate({
    projectId: req.projectId,
    title: req.title,
    body: req.body,
    template,
    mode: req.mode,
    roleAgentId,
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
