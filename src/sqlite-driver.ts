import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, ensureDataDir } from './config.ts';
import type { Db } from './sqlite.ts';

/** The PC driver. The phone build swaps this whole file for mobile/sqlite-driver.ts. */
export function openNodeDatabase(path: string): Db {
  const db = new DatabaseSync(path);
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  return db as unknown as Db;
}

export function openDatabase(): Db {
  ensureDataDir();
  return openNodeDatabase(DB_PATH);
}
