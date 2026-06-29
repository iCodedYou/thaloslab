// Cross-cutting constants for the global app directory and per-repo `.thalos/` layout.

/** Global app directory name under the user home (SPEC §3, DECISIONS #13). */
export const APP_DIR_NAME = '.thaloslab';
/** Daemon lockfile: `{ pid, port, startedAt }`. */
export const LOCKFILE_NAME = 'daemon.json';
/** Global SQLite DB filename (one DB across all projects, DECISIONS #14). */
export const DB_FILE_NAME = 'thalos.db';
export const LOGS_DIR_NAME = 'logs';
export const DAEMON_LOG_NAME = 'daemon.log';
export const SETTINGS_FILE_NAME = 'settings.json';

/**
 * Preferred daemon port; falls back to an ephemeral port if occupied (DECISIONS #13).
 * Chosen in an uncommon range to avoid well-known collisions (e.g. 4317 = OTLP).
 */
export const DEFAULT_DAEMON_PORT = 8473;
/** Daemon binds loopback only. */
export const DAEMON_HOST = '127.0.0.1';
export const HEALTH_PATH = '/health';

/** Per-project repo directory holding artifact bytes, agent configs, worktrees, logs. */
export const THALOS_DIR_NAME = '.thalos';
export const THALOS_CONFIG_NAME = 'config.json';
export const THALOS_AGENTS_DIR = 'agents';
export const THALOS_ARTIFACTS_DIR = 'artifacts';
export const THALOS_WORKTREES_DIR = 'worktrees';
export const THALOS_RUNS_LOG = 'runs.log';

/** Shape of the daemon lockfile written to `~/.thaloslab/daemon.json`. */
export interface DaemonLockfile {
  pid: number;
  port: number;
  startedAt: number;
}

/** Response body of `GET /health`. */
export interface HealthResponse {
  ok: true;
  version: string;
  pid: number;
  port: number;
  startedAt: number;
}
