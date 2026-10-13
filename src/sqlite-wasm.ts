import type { Database as SqlJsDatabase, SqlValue as SqlJsValue, Statement as SqlJsStatement } from 'sql.js';
import type { Db, SqlValue, Statement } from './sqlite.ts';

const READ = /^\s*(SELECT|PRAGMA|EXPLAIN)\b/i;
/** Statements that can create a row, so the new row id is worth asking for. */
const INSERTS = /^\s*(INSERT|REPLACE)\b/i;

/**
 * How many prepared statements are kept. The app uses a few dozen fixed ones;
 * the rest are IN (?, ?, ...) lists of varying length, which would otherwise
 * pile up one per length.
 */
const MAX_CACHED = 200;

function bindable(params: SqlValue[]): SqlJsValue[] {
  return params.map((p) => (typeof p === 'bigint' ? Number(p) : p));
}

/**
 * sql.js behind the same surface as node:sqlite.
 *
 * Preparing a statement is most of the cost of a small query, and a scan runs
 * the same few statements thousands of times, so each is prepared once and
 * kept by its SQL. sql.js frees every open statement when the database is
 * exported for saving or closed, so both are wrapped here to forget the cache
 * at the same moment; mobile/sqlite-driver.ts calls export on the raw object
 * and never needs to know.
 */
export function wrapSqlJs(
  raw: SqlJsDatabase,
  onWrite: () => void = () => {},
): Db & { inTransaction(): boolean } {
  let open = false;
  const cache = new Map<string, SqlJsStatement>();

  // Export and close free the statements themselves, so the cache only has
  // to let go of them, not free them a second time.
  const realExport = raw.export.bind(raw);
  const realClose = raw.close.bind(raw);
  raw.export = () => {
    cache.clear();
    return realExport();
  };
  raw.close = () => {
    cache.clear();
    realClose();
  };

  function statement(sql: string): SqlJsStatement {
    let st = cache.get(sql);
    if (st) {
      // Most recently used goes to the back, so the oldest is evicted first.
      cache.delete(sql);
      cache.set(sql, st);
      return st;
    }
    st = raw.prepare(sql);
    cache.set(sql, st);
    if (cache.size > MAX_CACHED) {
      const [oldestSql, oldest] = cache.entries().next().value as [string, SqlJsStatement];
      cache.delete(oldestSql);
      oldest.free();
    }
    return st;
  }

  /** Runs one use of a cached statement, always leaving it reset for the next. */
  function using<T>(sql: string, params: SqlValue[], use: (st: SqlJsStatement) => T): T {
    const st = statement(sql);
    try {
      st.bind(bindable(params));
      return use(st);
    } finally {
      // An unreset statement keeps its read open, and a failed one cannot be
      // stepped again until it is reset.
      st.reset();
    }
  }

  function lastRowId(): number {
    return Number(using('SELECT last_insert_rowid() AS id', [], (st) => (st.step() ? st.get()[0] : 0)) ?? 0);
  }

  function prepare(sql: string): Statement {
    const reads = READ.test(sql);
    const inserts = INSERTS.test(sql);
    return {
      get(...params) {
        return using(sql, params, (st) =>
          st.step() ? (st.getAsObject() as Record<string, unknown>) : undefined,
        );
      },
      all(...params) {
        return using(sql, params, (st) => {
          const rows: Record<string, unknown>[] = [];
          while (st.step()) rows.push(st.getAsObject() as Record<string, unknown>);
          return rows;
        });
      },
      run(...params) {
        using(sql, params, (st) => st.step());
        const changes = raw.getRowsModified();
        if (!reads) onWrite();
        // Only an insert can have made a new row, so only then is the id
        // looked up straight away. Anything else reads it only if asked,
        // which no caller does, and gets the connection's last id as
        // node:sqlite would.
        if (inserts) return { changes, lastInsertRowid: lastRowId() };
        return {
          changes,
          get lastInsertRowid() {
            return lastRowId();
          },
        };
      },
    };
  }

  return {
    exec(sql) {
      raw.exec(sql);
      if (/^\s*BEGIN\b/i.test(sql)) open = true;
      else if (/^\s*(COMMIT|END|ROLLBACK)\b/i.test(sql)) open = false;
      if (!READ.test(sql)) onWrite();
    },
    prepare,
    inTransaction: () => open,
  };
}
