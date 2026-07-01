// Locate how to launch the collab peer-agent — mirrors daemon-locate. Prefers the built DB-less bundle
// (daemon dist/peer-agent.js); falls back to the TS source via the tsx loader in dev. The peer runs as
// its OWN process (never in-process with the CLI) so its DB-free closure is preserved at runtime.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface PeerLaunch {
  command: string;
  args: string[];
  cwd: string;
}

export function resolvePeerLaunch(): PeerLaunch {
  const require = createRequire(import.meta.url);
  const daemonDir = path.dirname(require.resolve('@thaloslab/daemon/package.json'));

  const distEntry = path.join(daemonDir, 'dist', 'peer-agent.js');
  if (fs.existsSync(distEntry)) {
    return { command: process.execPath, args: [distEntry], cwd: daemonDir };
  }

  const tsxLoaderUrl = pathToFileURL(require.resolve('tsx')).href;
  const srcEntry = path.join(daemonDir, 'src', 'collab', 'peer-agent', 'index.ts');
  return { command: process.execPath, args: ['--import', tsxLoaderUrl, srcEntry], cwd: daemonDir };
}
