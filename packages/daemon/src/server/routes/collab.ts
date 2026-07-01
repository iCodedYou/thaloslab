// Collab routes (SPEC §11). These drive the `collabService`, NOT the bare `collab` runtime — because the
// service is the ONLY thing that also opens/closes the real `CollabEndpoint` socket. Driving the runtime
// alone (as this file used to) flips the trust state but starts NO listener, so no peer can ever connect.
// The admit action is an EXPLICIT host POST — a valid join token alone never authorizes a peer (the
// transport trust model). The manifests endpoint is the SECURITY surface for axis 3: the host can see
// exactly what crossed (path + sha256 of every file sent, + what was withheld).
import type { FastifyInstance } from 'fastify';
import { collabService } from '../../collab/collab-service';
import { listManifests } from '../../collab/manifest-store';
import { getProject } from '../../store/repositories/projects';

export function registerCollabRoutes(app: FastifyInstance): void {
  app.get('/api/collab', () => ({
    ...collabService.state(),
    collabPort: collabService.endpoint.port,
  }));

  // Host consents to pool → open the LOOPBACK listener (127.0.0.1). Idempotent: a second enable while the
  // socket is already up just returns the current state. Off-loopback exposure is a SEPARATE consent (F2).
  app.post('/api/collab/enable', async () => {
    if (!collabService.endpoint.listening) await collabService.enable();
    return { ...collabService.state(), collabPort: collabService.endpoint.port };
  });

  app.post('/api/collab/disable', async () => {
    await collabService.disable(); // revokes every session AND closes the listener (port released)
    return { ...collabService.state(), collabPort: collabService.endpoint.port };
  });

  // Issue a ONE-TIME join token for a peer to present on connect. The token alone never authorizes — the
  // peer still parks on `join.pending` until the explicit admit below.
  app.post<{ Params: { peerId: string } }>('/api/collab/peers/:peerId/invite', (req) => ({
    token: collabService.invite(req.params.peerId),
  }));

  app.post<{ Params: { peerId: string } }>('/api/collab/peers/:peerId/admit', (req) => {
    collabService.admit(req.params.peerId); // the explicit human admit → notifies the parked socket
    return collabService.state();
  });

  app.post<{ Params: { peerId: string } }>('/api/collab/peers/:peerId/revoke', (req) => {
    collabService.revoke(req.params.peerId); // marks revoked, severs the live socket, drops pooled adapters
    return collabService.state();
  });

  // The REAL persisted record of exactly what left the host for each peer invocation.
  app.get<{ Params: { projectId: string } }>('/api/collab/:projectId/manifests', (req) => {
    const repoPath = getProject(req.params.projectId)?.repoPath;
    return repoPath ? listManifests(repoPath) : [];
  });
}
