// New coverage (Phase 6): the reuse-or-spawn DECISION the Tauri shell relies on by exec-ing
// `thaloslab --no-open`. The shell replicates none of this — so the "never start a second daemon"
// guarantee lives here (plus the daemon's own PID-idempotency backstop). Health-ping is mocked.
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./app-paths', () => ({
  readLockfile: vi.fn(),
  removeLockfile: vi.fn(),
  daemonLogPath: () => '/tmp/daemon.log',
}));
vi.mock('./daemon-locate', () => ({
  resolveDaemonLaunch: () => ({ command: 'node', args: ['x'], cwd: '.' }),
}));
vi.mock('./daemon-process', () => ({
  pingHealth: vi.fn(),
  spawnDaemon: vi.fn(),
  waitForDaemon: vi.fn(),
}));

const { readLockfile, removeLockfile } = await import('./app-paths');
const { pingHealth, spawnDaemon, waitForDaemon } = await import('./daemon-process');
const { launchDaemon, DaemonStartError } = await import('./launch');

afterEach(() => vi.clearAllMocks());

describe('launchDaemon — reuse-or-spawn (the lifecycle the shell execs, never reimplements)', () => {
  it('REUSES a healthy daemon from the lockfile — never spawns a second instance', async () => {
    vi.mocked(readLockfile).mockReturnValue({ pid: 123, port: 8473, startedAt: 1 });
    vi.mocked(pingHealth).mockResolvedValue({
      ok: true,
      version: '0',
      pid: 123,
      port: 8473,
      startedAt: 1,
    });

    const r = await launchDaemon('mock');

    expect(r).toEqual({ port: 8473, reused: true, url: 'http://127.0.0.1:8473/' });
    expect(spawnDaemon).not.toHaveBeenCalled(); // the anti-"second daemon" guarantee
    expect(removeLockfile).not.toHaveBeenCalled();
  });

  it('cleans a STALE lockfile (dead daemon) then spawns fresh', async () => {
    vi.mocked(readLockfile).mockReturnValue({ pid: 999, port: 8473, startedAt: 1 });
    vi.mocked(pingHealth).mockResolvedValue(null); // not healthy
    vi.mocked(waitForDaemon).mockResolvedValue({
      ok: true,
      version: '0',
      pid: 1,
      port: 8480,
      startedAt: 2,
    });

    const r = await launchDaemon('mock');

    expect(removeLockfile).toHaveBeenCalledOnce();
    expect(spawnDaemon).toHaveBeenCalledOnce();
    expect(r).toEqual({ port: 8480, reused: false, url: 'http://127.0.0.1:8480/' });
  });

  it('spawns fresh when there is no lockfile', async () => {
    vi.mocked(readLockfile).mockReturnValue(null);
    vi.mocked(waitForDaemon).mockResolvedValue({
      ok: true,
      version: '0',
      pid: 1,
      port: 8473,
      startedAt: 2,
    });

    const r = await launchDaemon('mock');

    expect(pingHealth).not.toHaveBeenCalled();
    expect(spawnDaemon).toHaveBeenCalledOnce();
    expect(r.reused).toBe(false);
  });

  it('throws DaemonStartError (with the log path) when the spawned daemon never becomes healthy', async () => {
    vi.mocked(readLockfile).mockReturnValue(null);
    vi.mocked(waitForDaemon).mockResolvedValue(null); // timeout

    await expect(launchDaemon('mock', 10)).rejects.toBeInstanceOf(DaemonStartError);
  });
});
