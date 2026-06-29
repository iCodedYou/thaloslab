// Builds the Fastify instance. Routes/WS/static are registered here as later phases add them;
// Phase 0 wires health (this step), then providers + projects routes (later steps).
import Fastify, { type FastifyInstance } from 'fastify';
import type { Runtime } from '../workflow/runtime';
import { registerHealth, type HealthContext } from './health';
import { registerProviderRoutes } from './routes/providers';
import { registerProjectRoutes } from './routes/projects';
import { registerTicketRoutes } from './routes/tickets';
import { registerGateRoutes } from './routes/gates';

export interface BuildAppOptions {
  health: HealthContext;
  /** Workflow engine runtime; when present, ticket/gate routes are wired (Phase 1). */
  runtime?: Runtime;
}

export function buildApp(opts: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  registerHealth(app, opts.health);
  registerProviderRoutes(app);
  registerProjectRoutes(app);
  if (opts.runtime) {
    registerTicketRoutes(app, opts.runtime);
    registerGateRoutes(app, opts.runtime);
  }
  return app;
}
