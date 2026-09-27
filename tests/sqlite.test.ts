import { test } from 'node:test';
import assert from 'node:assert/strict';
import initSqlJs from 'sql.js';
import { openNodeDatabase } from '../src/sqlite-driver.ts';
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
