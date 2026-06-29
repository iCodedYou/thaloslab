// Daemon lockfile read/write + liveness (DECISIONS #13). Makes `thaloslab` launch idempotent
// and crash-safe: a stale lockfile (dead PID) is cleaned and replaced on the next start.
import fs from 'node:fs';
import type { DaemonLockfile } from '@thaloslab/shared';
import { lockfilePath } from './paths';

export function readLockfile(): DaemonLockfile | null {
  try {
    const raw = fs.readFileSync(lockfilePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<DaemonLockfile>;
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

export function writeLockfile(lock: DaemonLockfile): void {
  fs.writeFileSync(lockfilePath(), `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
}

export function removeLockfile(): void {
  try {
    fs.unlinkSync(lockfilePath());
  } catch {
    // already gone — fine
  }
}

/**
 * Is a process with this PID alive? Uses signal 0 (no signal sent, just an existence check).
 * ESRCH → no such process; EPERM → exists but not owned by us (treat as alive).
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
