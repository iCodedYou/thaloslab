// Spawn the daemon detached and wait (bounded) for it to become healthy. The daemon picks its
// own port and records it in the lockfile, so we poll the lockfile then health-ping that port.
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { DAEMON_HOST, HEALTH_PATH, type HealthResponse } from '@thaloslab/shared';
import { readLockfile } from './app-paths';
import type { DaemonLaunch } from './daemon-locate';

export async function pingHealth(port: number, timeoutMs = 1500): Promise<HealthResponse | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${DAEMON_HOST}:${port}${HEALTH_PATH}`, { signal: ctrl.signal });
    if (!res.ok) return null;
    return (await res.json()) as HealthResponse;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function spawnDaemon(launch: DaemonLaunch, mode: string): void {
  const debug = process.env.THALOS_DEBUG_SPAWN === '1';
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    detached: !debug,
    stdio: debug ? 'inherit' : 'ignore',
    env: { ...process.env, NODE_NO_WARNINGS: '1', THALOS_MODE: mode },
  });
  if (!debug) child.unref();
}

/** Poll the lockfile + health until the daemon is up or the timeout elapses. */
export async function waitForDaemon(timeoutMs: number): Promise<HealthResponse | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lock = readLockfile();
    if (lock) {
      const health = await pingHealth(lock.port);
      if (health && health.pid === lock.pid) return health;
    }
    await delay(300);
  }
  return null;
}
