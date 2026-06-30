// Observability routes (SPEC §15, Phase 6). Read-only, same-origin loopback, no new auth — consistent
// with the rest of /api. They return ONLY the metadata-only rollups from workflow/telemetry.ts; no
// prompt/output/raw-chunk ever crosses this surface (proven by the leak test).
import type { FastifyInstance } from 'fastify';
import { projectTelemetry, ticketTelemetry } from '../../workflow/telemetry';

export function registerObservabilityRoutes(app: FastifyInstance): void {
  app.get<{ Params: { projectId: string } }>('/api/observability/:projectId', (req) =>
    projectTelemetry(req.params.projectId),
  );
  app.get<{ Params: { id: string } }>('/api/tickets/:id/telemetry', (req) =>
    ticketTelemetry(req.params.id),
  );
}
