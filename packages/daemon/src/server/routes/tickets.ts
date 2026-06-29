// Ticket routes (SPEC §17). Create files a ticket through the orchestrator intake; detail returns
// the ticket + task graph + gates + artifacts + messages for the Tickets/DAG tab; events serves the
// seq-gap fetch a reconnecting WS client uses.
import type { ExecutionMode } from '@thaloslab/shared';
import type { FastifyInstance } from 'fastify';
import { listArtifactsByTicket } from '../../store/repositories/artifacts';
import { listGatesByTicket } from '../../store/repositories/gates';
import { listMessagesByTicket } from '../../store/repositories/messages';
import { listTasksByTicket } from '../../store/repositories/tasks';
import { eventsSince } from '../../store/repositories/task-events';
import { getTicket, listTickets } from '../../store/repositories/tickets';
import { intakeTicket } from '../../workflow/orchestrator/intake';
import type { Runtime } from '../../workflow/runtime';

interface CreateBody {
  projectId?: string;
  title?: string;
  body?: string;
  mode?: ExecutionMode;
}

export function registerTicketRoutes(app: FastifyInstance, runtime: Runtime): void {
  app.get('/api/tickets', (req) => {
    const { projectId } = req.query as { projectId?: string };
    return listTickets(projectId);
  });

  app.post('/api/tickets', async (req, reply) => {
    const body = (req.body ?? {}) as CreateBody;
    if (!body.projectId || !body.title) {
      reply.code(400);
      return { error: 'projectId and title are required' };
    }
    const ticket = await intakeTicket(runtime.engine, {
      projectId: body.projectId,
      title: body.title,
      body: body.body,
      mode: body.mode ?? 'preview',
    });
    return { ticket };
  });

  app.get('/api/tickets/:id', (req, reply) => {
    const { id } = req.params as { id: string };
    const ticket = getTicket(id);
    if (!ticket) {
      reply.code(404);
      return { error: 'not found' };
    }
    return {
      ticket,
      tasks: listTasksByTicket(id),
      gates: listGatesByTicket(id),
      artifacts: listArtifactsByTicket(id),
      messages: listMessagesByTicket(id),
    };
  });

  app.get('/api/tickets/:id/events', (req) => {
    const { id } = req.params as { id: string };
    const since = Number((req.query as { since?: string }).since ?? 0);
    return eventsSince(id, Number.isFinite(since) ? since : 0);
  });

  app.post('/api/tickets/:id/abort', (req) => {
    const { id } = req.params as { id: string };
    runtime.engine.abort(id);
    return { ok: true };
  });
}
