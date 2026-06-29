// Agent routes (SPEC §12 — the Agents tab). List the assembled roster for a project and edit the
// human-editable fields; edits mirror to the git-tracked `.thalos/agents/*.json`.
import type { AgentStatus } from '@thaloslab/shared';
import type { FastifyInstance } from 'fastify';
import {
  getAgent,
  listAgentsByProject,
  updateAgent,
  writeAgentFile,
} from '../../store/repositories/agents';
import { getProject } from '../../store/repositories/projects';

interface PatchBody {
  name?: string;
  systemPrompt?: string;
  status?: AgentStatus;
  model?: string;
}

export function registerAgentRoutes(app: FastifyInstance): void {
  app.get('/api/agents', (req, reply) => {
    const { projectId } = req.query as { projectId?: string };
    if (!projectId) {
      reply.code(400);
      return { error: 'projectId is required' };
    }
    return listAgentsByProject(projectId);
  });

  app.patch('/api/agents/:id', (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as PatchBody;
    const updated = updateAgent(id, body);
    if (!updated) {
      reply.code(404);
      return { error: 'not found' };
    }
    const repoPath = getProject(updated.projectId)?.repoPath;
    if (repoPath) writeAgentFile(repoPath, updated);
    return { agent: getAgent(id) };
  });
}
