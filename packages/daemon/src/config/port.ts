// Bind the preferred port, falling back to an OS-assigned ephemeral port if it's occupied
// (DECISIONS #13). Binding-then-reading the actual port avoids a check-then-bind race.
import type { FastifyInstance } from 'fastify';

export async function listenWithFallback(
  app: FastifyInstance,
  preferredPort: number,
  host: string,
): Promise<number> {
  try {
    await app.listen({ port: preferredPort, host });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    await app.listen({ port: 0, host }); // 0 → OS picks a free port
  }
  const addr = app.server.address();
  if (addr && typeof addr === 'object') return addr.port;
  throw new Error('daemon failed to bind a port');
}
