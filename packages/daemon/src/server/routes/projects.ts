// Project routes (SPEC §17). List, and create (scratch) or import.
import type { FastifyInstance } from 'fastify';
import type { ProviderId } from '@thaloslab/shared';
import { listProjects } from '../../store/repositories/projects';
import { createProject } from '../../project/create';
import { importProject } from '../../project/import';

interface CreateBody {
  origin?: 'scratch' | 'imported';
  name?: string;
  repoPath?: string;
  repoUrl?: string;
  orchestratorProvider?: ProviderId;
  github?: boolean;
}

export function registerProjectRoutes(app: FastifyInstance): void {
  app.get('/api/projects', () => listProjects());

  app.post('/api/projects', async (req, reply) => {
    const body = (req.body ?? {}) as CreateBody;
    const orchestratorProvider: ProviderId = body.orchestratorProvider ?? 'claude';

    if (!body.repoPath) {
      reply.code(400);
      return { error: 'repoPath is required' };
    }

    if (body.origin === 'imported') {
      return importProject({
        name: body.name,
        repoUrl: body.repoUrl,
        repoPath: body.repoPath,
        orchestratorProvider,
      });
    }

    return createProject({
      name: body.name ?? 'Untitled',
      repoPath: body.repoPath,
      orchestratorProvider,
      github: body.github,
    });
  });
}
