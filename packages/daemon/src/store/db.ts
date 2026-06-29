// Global SQLite handle + Drizzle wrapper (DECISIONS #14). Opened once during boot.
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { dbPath } from '../config/paths';
import * as schema from './schema';

export type DB = BetterSQLite3Database<typeof schema>;

let instance: { db: DB; raw: Database.Database; path: string } | null = null;

export function openDb(): DB {
  const path = dbPath();
  // Reopen if the target path changed (e.g. a test sets THALOS_DB_PATH); avoids a stale handle
  // pointing at a different database than the caller expects under worker reuse.
  if (instance && instance.path === path) return instance.db;
  if (instance) instance.raw.close();
  const raw = new Database(path);
  raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = ON');
  const db = drizzle(raw, { schema });
  instance = { db, raw, path };
  return db;
}

export function getDb(): DB {
  if (!instance) throw new Error('DB not opened — call openDb() during boot');
  return instance.db;
}

export function closeDb(): void {
  instance?.raw.close();
  instance = null;
}
