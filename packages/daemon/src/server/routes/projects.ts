// Project routes (SPEC §17). List, create (scratch) or import, and PATCH the routing policy (the collab
// opt-in + per-role collab targets). Setting the policy FEEDS the fail-closed G0 dispatch gate — it never
// bypasses it; default (no routingPolicy) stays collab OFF.
import type { FastifyInstance } from 'fastify';
import type { ProviderId } from '@thaloslab/shared';
import {
  getProject,
  listProjects,
  setProjectRoutingPolicy,
} from '../../store/repositories/projects';
import { isCollabProviderId } from '../../workflow/collab-route';
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

interface PatchBody {
  routingPolicy?: Record<string, unknown>;
}

/** Validate a routingPolicy body before persisting: `collabTargets` (if present) must map each role to a
 *  well-formed `collab:<peer>:<vendor>` id. Routability is NOT checked here — it's enforced LIVE at dispatch
 *  (a target for an offline peer is allowed here and PARKS at run time, never a silent local fall-back). */
function validateRoutingPolicy(rp: Record<string, unknown>): string | null {
  const targets = rp.collabTargets;
  if (targets === undefined) return null;
  if (typeof targets !== 'object' || targets === null || Array.isArray(targets)) {
    return 'collabTargets must be an object mapping role → "collab:<peer>:<vendor>"';
  }
  for (const [role, id] of Object.entries(targets as Record<string, unknown>)) {
    if (!isCollabProviderId(id)) {
      return `collabTargets.${role} must be a well-formed "collab:<peer>:<vendor>" id`;
    }
  }
  return null;
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

  // Set a project's routing policy (collab opt-in + collab targets). REPLACES routingPolicy with the body's
  // value. 404 unknown project; 400 malformed collab target. Absent routingPolicy in the body is a no-op.
  app.patch<{ Params: { id: string } }>('/api/projects/:id', (req, reply) => {
    const body = (req.body ?? {}) as PatchBody;
    if (!getProject(req.params.id)) {
      reply.code(404);
      return { error: 'project not found' };
    }
    if (body.routingPolicy !== undefined) {
      const err = validateRoutingPolicy(body.routingPolicy);
      if (err) {
        reply.code(400);
        return { error: err };
      }
      setProjectRoutingPolicy(req.params.id, body.routingPolicy);
    }
    return getProject(req.params.id);
  });
}
