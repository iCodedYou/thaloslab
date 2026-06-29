// Idempotent launch (DECISIONS #13): reuse a healthy daemon, clean a stale lockfile, otherwise
// spawn fresh and wait. On timeout, throw with the daemon log path so the failure is diagnosable.
import { DAEMON_HOST } from '@thaloslab/shared';
import { daemonLogPath, readLockfile, removeLockfile } from './app-paths';
import { resolveDaemonLaunch } from './daemon-locate';
import { pingHealth, spawnDaemon, waitForDaemon } from './daemon-process';

export interface LaunchResult {
  port: number;
  reused: boolean;
  url: string;
}

export class DaemonStartError extends Error {
  constructor(public readonly logPath: string) {
    super(`Daemon did not become healthy in time.\nCheck the log: ${logPath}`);
    this.name = 'DaemonStartError';
  }
}

function urlFor(port: number): string {
  return `http://${DAEMON_HOST}:${port}/`;
}

export async function launchDaemon(mode: string, timeoutMs = 15_000): Promise<LaunchResult> {
  const existing = readLockfile();
  if (existing) {
    const health = await pingHealth(existing.port);
    if (health) return { port: health.port, reused: true, url: urlFor(health.port) };
    removeLockfile(); // stale lockfile — dead daemon
  }

  spawnDaemon(resolveDaemonLaunch(), mode);
  const healthy = await waitForDaemon(timeoutMs);
  if (!healthy) throw new DaemonStartError(daemonLogPath());
  return { port: healthy.port, reused: false, url: urlFor(healthy.port) };
}
