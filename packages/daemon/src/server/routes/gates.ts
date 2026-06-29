// Gate routes (SPEC §17). Resolving a human gate writes the decision (single-flight) and resumes
// the engine via advance(). This is the durable resume path — it also works after a restart.
import type { GateDecision } from '@thaloslab/shared';
import type { FastifyInstance } from 'fastify';
import type { Runtime } from '../../workflow/runtime';

interface ResolveBody {
  decision?: GateDecision;
  comment?: string;
}

export function registerGateRoutes(app: FastifyInstance, runtime: Runtime): void {
  app.post('/api/gates/:id/resolve', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as ResolveBody;
    if (!body.decision) {
      reply.code(400);
      return { error: 'decision is required (approve | reject | request-changes)' };
    }
    await runtime.engine.resolveHumanGate(id, body.decision, 'user', body.comment);
    return { ok: true };
  });
}
