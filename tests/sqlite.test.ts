import { test } from 'node:test';
import assert from 'node:assert/strict';
import initSqlJs from 'sql.js';
import { openNodeDatabase, retryWhileLocked } from '../src/sqlite-driver.ts';
import { wrapSqlJs } from '../src/sqlite-wasm.ts';
import type { Db } from '../src/sqlite.ts';

const SQL = await initSqlJs();

const drivers: [string, () => Db][] = [
  ['node:sqlite', () => openNodeDatabase(':memory:')],
  ['sql.js', () => wrapSqlJs(new SQL.Database())],
];

for (const [name, open] of drivers) {
  const setup = () => {
    const db = open();
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, n INTEGER)');
    return db;
  };

  test(`${name}: run reports changes and the new row id`, () => {
    const db = setup();
    const r = db.prepare('INSERT INTO t (name, n) VALUES (?, ?)').run('a', 1);
    assert.equal(r.changes, 1);
    assert.equal(Number(r.lastInsertRowid), 1);
  });

  test(`${name}: get returns one row as a plain object, or undefined`, () => {
    const db = setup();
    db.prepare('INSERT INTO t (name, n) VALUES (?, ?)').run('a', null);
    assert.deepEqual({ ...db.prepare('SELECT name, n FROM t WHERE id = ?').get(1) }, { name: 'a', n: null });
    assert.equal(db.prepare('SELECT * FROM t WHERE id = ?').get(99), undefined);
  });

  test(`${name}: all returns every row, with spread placeholders`, () => {
    const db = setup();
    for (const x of ['a', 'b', 'c']) db.prepare('INSERT INTO t (name) VALUES (?)').run(x);
    const rows = db.prepare('SELECT name FROM t WHERE name IN (?, ?) ORDER BY name').all(...['a', 'c']);
    assert.deepEqual(
      rows.map((r) => r.name),
      ['a', 'c'],
    );
  });

  test(`${name}: a rolled back transaction leaves nothing behind`, () => {
    const db = setup();
    db.exec('BEGIN');
    db.prepare('INSERT INTO t (name) VALUES (?)').run('gone');
    db.exec('ROLLBACK');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM t').get()?.c, 0);
  });
}

test('sql.js: knows when a transaction is open', () => {
  const db = wrapSqlJs(new SQL.Database());
  db.exec('CREATE TABLE t (x)');
  assert.equal(db.inTransaction(), false);
  db.exec('BEGIN');
  assert.equal(db.inTransaction(), true);
  db.exec('COMMIT');
  assert.equal(db.inTransaction(), false);
});

test('sql.js: writes are reported, reads are not', () => {
  let writes = 0;
  const db = wrapSqlJs(new SQL.Database(), () => (writes += 1));
  db.exec('CREATE TABLE t (x)');
  db.prepare('INSERT INTO t VALUES (?)').run(1);
  const before = writes;
  db.prepare('SELECT * FROM t').all();
  db.prepare('SELECT * FROM t').get();
  assert.equal(writes, before);
  assert.ok(before >= 2);
});

/*
 * Switching a fresh database to WAL needs an exclusive lock, and when two
 * processes open the same file at the same moment SQLite answers one of them
 * "database is locked" at once, without waiting, to avoid a deadlock. That is
 * what happened when the test files ran in parallel on CI. The open retries.
 */
test('node:sqlite: a locked answer is retried until it clears', () => {
  let calls = 0;
  const slept: number[] = [];
  const out = retryWhileLocked(
    () => {
      calls += 1;
      if (calls < 3) throw lockedError();
      return 'open';
    },
    1_000,
    (ms) => slept.push(ms),
  );
  assert.equal(out, 'open');
  assert.equal(calls, 3);
  assert.equal(slept.length, 2);
});

test('node:sqlite: a lock that never clears gives up once the time allowed is spent', () => {
  let calls = 0;
  let clock = 0;
  assert.throws(
    () =>
      retryWhileLocked(
        () => {
          calls += 1;
          throw lockedError();
        },
        500,
        (ms) => {
          clock += ms;
        },
        () => clock,
      ),
    /database is locked/,
  );
  assert.ok(calls > 1);
  assert.ok(clock >= 500);
});

test('node:sqlite: any other error is thrown straight away', () => {
  let calls = 0;
  assert.throws(
    () =>
      retryWhileLocked(
        () => {
          calls += 1;
          throw new Error('no such table');
        },
        1_000,
        () => {},
      ),
    /no such table/,
  );
  assert.equal(calls, 1);
});

function lockedError(): Error {
  return Object.assign(new Error('database is locked'), {
    code: 'ERR_SQLITE_ERROR',
    errcode: 5,
  });
}

test('node:sqlite: a write waits for another process to finish, rather than failing as locked', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawn } = await import('node:child_process');
  const path = join(mkdtempSync(join(tmpdir(), 'pmt-lock-')), 'lock.db');
  const db = openNodeDatabase(path);
  db.exec('CREATE TABLE t (x)');

  // Another process takes the write lock, holds it briefly, then lets go.
  const holder = spawn(process.execPath, [
    '-e',
    `const { DatabaseSync } = require('node:sqlite');
     const d = new DatabaseSync(${JSON.stringify(path)});
     d.exec('BEGIN IMMEDIATE');
     process.stdout.write('locked');
     setTimeout(() => { d.exec('COMMIT'); d.close(); }, 400);`,
  ]);
  let stderr = '';
  holder.stderr.on('data', (d) => (stderr += d));
  await new Promise<void>((resolve, reject) => {
    holder.stdout.once('data', () => resolve());
    holder.once('exit', (code) => reject(new Error(`lock holder exited early (${code}): ${stderr}`)));
  });
  db.prepare('INSERT INTO t VALUES (?)').run(1);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM t').get()?.c, 1);
  await new Promise((r) => holder.once('exit', r));
});
