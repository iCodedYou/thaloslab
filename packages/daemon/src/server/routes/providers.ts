// Provider routes (SPEC §17). GET lists detected providers; redetect re-runs the sweep.
import type { FastifyInstance } from 'fastify';
import { listProviders } from '../../store/repositories/providers';
import { detectAll } from '../../providers/registry';

export function registerProviderRoutes(app: FastifyInstance): void {
  app.get('/api/providers', () => listProviders());
  app.post('/api/providers/redetect', () => detectAll());
}
