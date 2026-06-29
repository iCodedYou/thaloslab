// Builds the Fastify instance. Routes/WS/static are registered here as later phases add them;
// Phase 0 wires health (this step), then providers + projects routes (later steps).
import Fastify, { type FastifyInstance } from 'fastify';
import { registerHealth, type HealthContext } from './health';
import { registerProviderRoutes } from './routes/providers';
import { registerProjectRoutes } from './routes/projects';

export interface BuildAppOptions {
  health: HealthContext;
}

export function buildApp(opts: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  registerHealth(app, opts.health);
  registerProviderRoutes(app);
  registerProjectRoutes(app);
  return app;
}
