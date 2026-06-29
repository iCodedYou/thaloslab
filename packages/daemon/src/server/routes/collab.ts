// Collab routes (SPEC §11). The admit action is an EXPLICIT host POST — a valid join token alone never
// authorizes a peer (the transport trust model). The manifests endpoint is the SECURITY surface for
// axis 3: the host can see exactly what crossed (path + sha256 of every file sent, + what was withheld).
import type { FastifyInstance } from 'fastify';
import { listManifests } from '../../collab/manifest-store';
import { collab } from '../../collab/runtime';
import { getProject } from '../../store/repositories/projects';

export function registerCollabRoutes(app: FastifyInstance): void {
  app.get('/api/collab', () => collab.state());
  app.post('/api/collab/enable', () => {
    collab.host.enable();
    return collab.state();
  });
  app.post('/api/collab/disable', () => {
    collab.host.disable(); // returns the endpoint to 127.0.0.1-only + revokes every session
    return collab.state();
  });
  app.post<{ Params: { peerId: string } }>('/api/collab/peers/:peerId/admit', (req) => {
    collab.host.admit(req.params.peerId); // the explicit human admit
    return collab.state();
  });
  app.post<{ Params: { peerId: string } }>('/api/collab/peers/:peerId/revoke', (req) => {
    collab.host.revoke(req.params.peerId);
    return collab.state();
  });
  // The REAL persisted record of exactly what left the host for each peer invocation.
  app.get<{ Params: { projectId: string } }>('/api/collab/:projectId/manifests', (req) => {
    const repoPath = getProject(req.params.projectId)?.repoPath;
    return repoPath ? listManifests(repoPath) : [];
  });
}
