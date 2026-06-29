// Apply migrations at boot. The .sql files are data (not bundled by tsup), so we resolve the
// folder relative to this module and assert it exists — failing loudly with the resolved paths
// rather than crashing opaquely on the first query (DECISIONS #13, plan risk R6).
import fs from 'node:fs';
import path from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { moduleDir } from '../config/paths';
import type { DB } from './db';

export function migrationsFolder(): string {
  const here = moduleDir(import.meta.url);
  const candidates = [
    path.resolve(here, '..', '..', 'migrations'), // dev (tsx): src/store -> packages/daemon/migrations
    path.resolve(here, 'migrations'), // bundle: dist/ -> dist/migrations
    path.resolve(here, '..', 'migrations'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'meta', '_journal.json'))) return candidate;
  }
  throw new Error(`migrations folder not found; looked in:\n  ${candidates.join('\n  ')}`);
}

export function runMigrations(db: DB): void {
  migrate(db, { migrationsFolder: migrationsFolder() });
}
