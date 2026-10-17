/**
 * The slice of SQLite the app uses, run on node:sqlite. Kept as an interface
 * so nothing outside sqlite-driver.ts depends on the driver itself.
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
