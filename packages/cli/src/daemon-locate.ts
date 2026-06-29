// Locate how to launch the daemon. Prefers the built bundle (dist/index.js); falls back to
// running the TS source via the tsx loader in dev (Phase 0 steps 2–7 run on tsx; step 8 builds).
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface DaemonLaunch {
  command: string;
  args: string[];
  cwd: string;
}

export function resolveDaemonLaunch(): DaemonLaunch {
  const require = createRequire(import.meta.url);
  const daemonDir = path.dirname(require.resolve('@thaloslab/daemon/package.json'));

  const distEntry = path.join(daemonDir, 'dist', 'index.js');
  if (fs.existsSync(distEntry)) {
    return { command: process.execPath, args: [distEntry], cwd: daemonDir };
  }

  // Dev fallback: run TS source under the tsx loader. Resolve tsx to an ABSOLUTE file URL so the
  // spawned process doesn't depend on cwd-relative module resolution (which fails through pnpm's
  // symlinked node_modules).
  const tsxLoaderUrl = pathToFileURL(require.resolve('tsx')).href;
  const srcEntry = path.join(daemonDir, 'src', 'index.ts');
  return { command: process.execPath, args: ['--import', tsxLoaderUrl, srcEntry], cwd: daemonDir };
}
