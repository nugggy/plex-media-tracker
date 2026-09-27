/**
 * The phone's stand-in for src/sqlite-driver.ts: sql.js in memory, saved to
 * the app's private storage by mobile/persist.ts. The phone build swaps this
 * in, so it exports the same openDatabase().
 */
import initSqlJs, { type Database } from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { wrapSqlJs } from '../src/sqlite-wasm.ts';
import type { Db } from '../src/sqlite.ts';
import { createSaver } from './persist.ts';
import { saveDatabase, loadDatabase, toBase64, fromBase64, type FileApi } from './storage.ts';

const capFs: FileApi = {
  async read(path) {
    try {
      const r = await Filesystem.readFile({ path, directory: Directory.Data });
      return fromBase64(r.data as string);
    } catch {
      return null;
    }
  },
  async write(path, bytes) {
    await Filesystem.writeFile({ path, directory: Directory.Data, data: toBase64(bytes) });
  },
  async remove(path) {
    await Filesystem.deleteFile({ path, directory: Directory.Data });
  },
  async rename(from, to) {
    await Filesystem.rename({ from, to, directory: Directory.Data, toDirectory: Directory.Data });
  },
};

let db: (Db & { inTransaction(): boolean }) | null = null;
let saver: ReturnType<typeof createSaver> | null = null;

/** Must finish before anything imports src/db.ts. mobile/entry.ts sees to that. */
export async function initMobileDatabase(): Promise<void> {
  const SQL = await initSqlJs({ locateFile: () => wasmUrl });
  const isValid = (b: Uint8Array) => {
    try {
      const probe = new SQL.Database(b);
      probe.exec('SELECT count(*) FROM sqlite_master');
      probe.close();
      return true;
    } catch {
      return false;
    }
  };
  const bytes = await loadDatabase(capFs, isValid);
  const raw: Database = bytes ? new SQL.Database(bytes) : new SQL.Database();
  saver = createSaver({
    save: () => saveDatabase(capFs, raw.export()),
    inTransaction: () => db!.inTransaction(),
  });
  db = wrapSqlJs(raw, () => saver!.markDirty());
  // Leaving the app is the last safe moment to save before Android may kill it.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void saver!.flush();
  });
}

export function openDatabase(): Db {
  if (!db) throw new Error('initMobileDatabase() has not run');
  return db;
}

export const flushDatabase = (): Promise<void> => saver?.flush() ?? Promise.resolve();
