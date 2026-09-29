import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, ensureDataDir } from './config.ts';
import type { Db } from './sqlite.ts';

/** How long an open waits for another process before giving up. */
const LOCK_WAIT_MS = 5_000;

function isLocked(err: unknown): boolean {
  return (err as { code?: string; errcode?: number })?.code === 'ERR_SQLITE_ERROR' &&
    (err as { errcode?: number }).errcode === 5;
}

/** Blocks the thread briefly. Opening the database is synchronous, so a promise would not do. */
function blockFor(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Runs `fn` again while it answers "database is locked", up to the time
 * allowed. SQLite's own busy wait covers most contention, but not the case
 * where two connections each hold a lock the other wants: there it returns
 * locked at once rather than risk a deadlock, so the caller has to try again.
 */
export function retryWhileLocked<T>(
  fn: () => T,
  timeoutMs: number,
  sleep: (ms: number) => void = blockFor,
  now: () => number = Date.now,
): T {
  const start = now();
  let wait = 20;
  for (;;) {
    try {
      return fn();
    } catch (err) {
      if (!isLocked(err) || now() - start >= timeoutMs) throw err;
      sleep(wait);
      wait = Math.min(wait * 2, 500);
    }
  }
}

/** The PC driver. The phone build swaps this whole file for mobile/sqlite-driver.ts. */
export function openNodeDatabase(path: string): Db {
  // Another process (a command-line scan, a test) may hold the write lock for
  // a moment. Wait up to five seconds for it instead of failing at once.
  const db = new DatabaseSync(path, { timeout: LOCK_WAIT_MS });
  // Switching a fresh file to WAL wants an exclusive lock, and two processes
  // opening the same new file together are the deadlock case above.
  if (path !== ':memory:') retryWhileLocked(() => db.exec('PRAGMA journal_mode = WAL'), LOCK_WAIT_MS);
  return db as unknown as Db;
}

export function openDatabase(): Db {
  ensureDataDir();
  return openNodeDatabase(DB_PATH);
}
