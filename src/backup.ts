import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './config.ts';
import { db } from './db.ts';
import { today } from './dates.ts';

/**
 * The NAS's storage pool has no room for snapshots, so the app keeps its own
 * copies. A plain file copy of a live WAL database can catch it mid-write;
 * VACUUM INTO writes a consistent copy from inside SQLite instead.
 */
export const BACKUP_DIR = join(DATA_DIR, 'backups');

/** Daily copies kept. The database is a few megabytes, so two weeks costs little. */
export const KEEP_BACKUPS = 14;

const BACKUP_NAME = /^plex-media-tracker-(\d{4}-\d{2}-\d{2})\.db$/;

export function backupName(date: string): string {
  return `plex-media-tracker-${date}.db`;
}

/** The backups to delete so only the newest `keep` remain. Other files are left alone. */
export function backupsToPrune(names: string[], keep: number = KEEP_BACKUPS): string[] {
  const dated = names.filter((n) => BACKUP_NAME.test(n)).sort();
  return dated.slice(0, Math.max(0, dated.length - keep));
}

/**
 * Writes today's copy unless it exists, then prunes old ones. Returns the path
 * written, or null when today's copy was already there.
 */
export function maybeDailyBackup(dir: string = BACKUP_DIR, date: string = today()): string | null {
  const target = join(dir, backupName(date));
  if (existsSync(target)) return null;
  mkdirSync(dir, { recursive: true });
  // Written under another name first, so a copy cut short by a restart is
  // never mistaken for a finished one.
  const partial = `${target}.partial`;
  rmSync(partial, { force: true });
  db.exec(`VACUUM INTO '${partial.replaceAll("'", "''")}'`);
  renameSync(partial, target);
  for (const old of backupsToPrune(readdirSync(dir))) rmSync(join(dir, old), { force: true });
  return target;
}

/** Runs the daily backup, logging rather than throwing so the server carries on. */
export function runDailyBackup(): void {
  try {
    const written = maybeDailyBackup();
    if (written) process.stdout.write(`  Backed up the database to ${written}\n`);
  } catch (err) {
    process.stderr.write(`  Database backup failed: ${(err as Error).message}\n`);
  }
}
