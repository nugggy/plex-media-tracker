import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Its own throwaway database: backup.ts opens one on import, and test files
// run in parallel, so sharing the default file would mean sharing its locks.
process.env.PLEX_TRACKER_DATA_DIR = mkdtempSync(join(tmpdir(), 'pmt-backup-'));
const { backupName, backupsToPrune, maybeDailyBackup } = await import('../src/backup.ts');
const { setSetting } = await import('../src/db.ts');

test('only the oldest backups beyond the limit are pruned', () => {
  const names = ['2026-10-03', '2026-10-01', '2026-10-02', '2026-10-04'].map(backupName);
  assert.deepEqual(backupsToPrune([...names, 'notes.txt'], 2), [backupName('2026-10-01'), backupName('2026-10-02')]);
  assert.deepEqual(backupsToPrune(names, 14), []);
});

test('a daily backup is a working copy, written once a day, and old ones go', () => {
  setSetting('backup_test', 'kept');
  const dir = mkdtempSync(join(tmpdir(), 'pmt-backups-'));
  for (let day = 1; day <= 14; day++) {
    writeFileSync(join(dir, backupName(`2026-09-${String(day).padStart(2, '0')}`)), '');
  }

  const written = maybeDailyBackup(dir, '2026-10-17');
  assert.equal(written, join(dir, backupName('2026-10-17')));
  assert.equal(maybeDailyBackup(dir, '2026-10-17'), null);

  const copy = new DatabaseSync(written!);
  const row = copy.prepare("SELECT value FROM settings WHERE key = 'backup_test'").get();
  copy.close();
  assert.equal(row?.value, 'kept');

  const left = readdirSync(dir);
  assert.equal(left.length, 14);
  assert.equal(existsSync(join(dir, backupName('2026-09-01'))), false);
  assert.equal(left.some((n) => n.endsWith('.partial')), false);
});
