// CLI-side resolution of the global app dir / lockfile. The CLI and daemon independently locate
// these from the shared constants (single source of truth), so the CLI never imports daemon
// internals.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  APP_DIR_NAME,
  DAEMON_LOG_NAME,
  LOCKFILE_NAME,
  LOGS_DIR_NAME,
  type DaemonLockfile,
} from '@thaloslab/shared';

export function appDir(): string {
  return path.join(os.homedir(), APP_DIR_NAME);
}

export function lockfilePath(): string {
  return path.join(appDir(), LOCKFILE_NAME);
}

export function daemonLogPath(): string {
  return path.join(appDir(), LOGS_DIR_NAME, DAEMON_LOG_NAME);
}

export function readLockfile(): DaemonLockfile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockfilePath(), 'utf8')) as Partial<DaemonLockfile>;
    if (
      typeof parsed.pid === 'number' &&
      typeof parsed.port === 'number' &&
      typeof parsed.startedAt === 'number'
    ) {
      return { pid: parsed.pid, port: parsed.port, startedAt: parsed.startedAt };
    }
    return null;
  } catch {
    return null;
  }
}

export function removeLockfile(): void {
  try {
    fs.unlinkSync(lockfilePath());
  } catch {
    // already gone
  }
}
