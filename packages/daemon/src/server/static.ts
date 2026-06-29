// Serve the built web SPA in production (bundle). In dev (tsx) there is no dist/public — Vite
// serves the UI and proxies here — so this no-ops. The SPA fallback returns index.html for any
// non-/api, non-/ws GET so client-side routing works.
import fs from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { moduleDir } from '../config/paths';

function resolvePublicDir(): string | null {
  const here = moduleDir(import.meta.url);
  const candidates = [path.join(here, 'public'), path.join(here, '..', 'public')];
  return candidates.find((dir) => fs.existsSync(path.join(dir, 'index.html'))) ?? null;
}

export async function registerStatic(app: FastifyInstance): Promise<boolean> {
  const publicDir = resolvePublicDir();
  if (!publicDir) return false;

  await app.register(fastifyStatic, { root: publicDir, prefix: '/' });

  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api') && !req.url.startsWith('/ws')) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ error: 'Not Found', url: req.url });
  });

  return true;
}
