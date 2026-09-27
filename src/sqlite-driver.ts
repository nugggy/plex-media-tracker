import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, ensureDataDir } from './config.ts';
import type { Db } from './sqlite.ts';

/** The PC driver. The phone build swaps this whole file for mobile/sqlite-driver.ts. */
export function openNodeDatabase(path: string): Db {
  // Another process (a command-line scan, a test) may hold the write lock for
  // a moment. Wait up to five seconds for it instead of failing at once.
  const db = new DatabaseSync(path, { timeout: 5_000 });
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  return db as unknown as Db;
}

export function openDatabase(): Db {
  ensureDataDir();
  return openNodeDatabase(DB_PATH);
}
