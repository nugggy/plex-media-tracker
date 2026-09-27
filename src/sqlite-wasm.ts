import type { Database as SqlJsDatabase, SqlValue as SqlJsValue } from 'sql.js';
import type { Db, SqlValue, Statement } from './sqlite.ts';

const READ = /^\s*(SELECT|PRAGMA|EXPLAIN)\b/i;

function bindable(params: SqlValue[]): SqlJsValue[] {
  return params.map((p) => (typeof p === 'bigint' ? Number(p) : p));
}

/**
 * sql.js behind the same surface as node:sqlite. Statements are prepared and
 * freed per call, because sql.js frees every open statement when the database
 * is exported for saving.
 */
export function wrapSqlJs(
  raw: SqlJsDatabase,
  onWrite: () => void = () => {},
): Db & { inTransaction(): boolean } {
  let open = false;

  function prepare(sql: string): Statement {
    const reads = READ.test(sql);
    return {
      get(...params) {
        const st = raw.prepare(sql);
        try {
          st.bind(bindable(params));
          return st.step() ? (st.getAsObject() as Record<string, unknown>) : undefined;
        } finally {
          st.free();
        }
      },
      all(...params) {
        const st = raw.prepare(sql);
        try {
          st.bind(bindable(params));
          const rows: Record<string, unknown>[] = [];
          while (st.step()) rows.push(st.getAsObject() as Record<string, unknown>);
          return rows;
        } finally {
          st.free();
        }
      },
      run(...params) {
        const st = raw.prepare(sql);
        try {
          st.bind(bindable(params));
          st.step();
        } finally {
          st.free();
        }
        const changes = raw.getRowsModified();
        const id = raw.exec('SELECT last_insert_rowid()')[0]?.values[0]?.[0] ?? 0;
        if (!reads) onWrite();
        return { changes, lastInsertRowid: Number(id) };
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
