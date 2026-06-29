// GET /health — the liveness/identity probe the CLI health-pings to decide reuse-or-start.
import type { FastifyInstance } from 'fastify';
import { HEALTH_PATH, type HealthResponse } from '@thaloslab/shared';

export interface HealthContext {
  version: string;
  startedAt: number;
  getPort: () => number;
}

export function registerHealth(app: FastifyInstance, ctx: HealthContext): void {
  app.get(HEALTH_PATH, (): HealthResponse => {
    return {
      ok: true,
      version: ctx.version,
      pid: process.pid,
      port: ctx.getPort(),
      startedAt: ctx.startedAt,
    };
  });
}
