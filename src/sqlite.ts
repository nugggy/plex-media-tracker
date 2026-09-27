/**
 * The slice of SQLite the app uses. The PC runs it on node:sqlite, the phone
 * on sql.js, and nothing outside the two drivers knows which.
 */
export type SqlValue = string | number | bigint | null | Uint8Array;

export interface Statement {
  get(...params: SqlValue[]): Record<string, unknown> | undefined;
  all(...params: SqlValue[]): Record<string, unknown>[];
  run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}

export interface Db {
  exec(sql: string): void;
  prepare(sql: string): Statement;
}
