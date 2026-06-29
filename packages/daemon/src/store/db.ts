// Global SQLite handle + Drizzle wrapper (DECISIONS #14). Opened once during boot.
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { dbPath } from '../config/paths';
import * as schema from './schema';

export type DB = BetterSQLite3Database<typeof schema>;

let instance: { db: DB; raw: Database.Database } | null = null;

export function openDb(): DB {
  if (instance) return instance.db;
  const raw = new Database(dbPath());
  raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = ON');
  const db = drizzle(raw, { schema });
  instance = { db, raw };
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
