// Global app directory resolution (SPEC §3, DECISIONS #13/#14). One global dir under the
// user home holds the SQLite DB, daemon lockfile, logs, and settings — distinct from each
// project's per-repo `.thalos/`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APP_DIR_NAME,
  DAEMON_LOG_NAME,
  DB_FILE_NAME,
  LOCKFILE_NAME,
  LOGS_DIR_NAME,
  SETTINGS_FILE_NAME,
} from '@thaloslab/shared';

export function appDir(): string {
  return path.join(os.homedir(), APP_DIR_NAME);
}

export function dbPath(): string {
  // Override for tests / alternate stores; defaults to the global app dir.
  return process.env.THALOS_DB_PATH ?? path.join(appDir(), DB_FILE_NAME);
}

export function lockfilePath(): string {
  return path.join(appDir(), LOCKFILE_NAME);
}

export function logsDir(): string {
  return path.join(appDir(), LOGS_DIR_NAME);
}

export function daemonLogPath(): string {
  return path.join(logsDir(), DAEMON_LOG_NAME);
}

export function settingsPath(): string {
  return path.join(appDir(), SETTINGS_FILE_NAME);
}

/** Create the global app dir + logs dir if missing. Home is always writable. */
export function ensureAppDir(): void {
  fs.mkdirSync(appDir(), { recursive: true });
  fs.mkdirSync(logsDir(), { recursive: true });
}

/** ESM replacement for `__dirname`. Pass `import.meta.url` from the calling module. */
export function moduleDir(importMetaUrl: string): string {
  return path.dirname(fileURLToPath(importMetaUrl));
}
