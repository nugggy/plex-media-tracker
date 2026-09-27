# Android app implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the tracker as a self-contained Android app on a OnePlus 15, built from the same codebase as the PC version, delivered as a signed APK through GitHub releases.

**Architecture:** Capacitor wraps `public/` as an Android app. The backend in `src/` runs inside the web view, behind two seams: a transport-free `route()` over the existing `handleApi`, and a `Db` interface with a `node:sqlite` driver on the PC and a sql.js driver on the phone. A native foreground service keeps long scans alive in the background, proven by a spike before the port is built on it.

**Tech stack:** Node 24, TypeScript run directly on the PC, esbuild for the phone bundle, sql.js 1.14, Capacitor 8.5 (core, cli, android, filesystem), Kotlin, Gradle with JDK 21, GitHub Actions.

**Spec:** `docs/specs/2026-09-27-android-app-design.md`

## Global constraints

- Australian English in all UI copy, comments and docs. No em dashes in copy.
- The PC version must keep working exactly as now: `npm start`, `npm test`, `npm run typecheck` all pass after every task.
- No Node-only module (`node:*`, `Buffer`, `process`) may be reachable from the phone bundle except through `src/config.ts` and `src/sqlite-driver.ts`, which the phone build swaps out.
- App version 1.2.0. APK file name `plex-media-tracker-<version>.apk`. Android app id `com.nugggy.plexmediatracker`. App name "Plex Media Tracker".
- Build with JDK 21 from `C:\Program Files\Android\Android Studio\jbr` (Capacitor 8 needs 21; the spec's JDK 17 line is corrected in Task 4). Android SDK at `%LOCALAPPDATA%\Android\Sdk`, compile SDK 36.
- Never commit a keystore, `keystore.properties`, a database file, or `dist/`.
- The repository is private: `plex-media-tracker` on GitHub.
- Credentials (keystore passwords, the keystore itself as a secret) are entered into GitHub by the user, not by the agent.

## Review focus

1. A scan writes to the database constantly, so a save that waits for five quiet seconds would never fire mid-scan. Expected: a save happens at least every 30 seconds while writes continue. Pinned in Task 6.
2. The app is killed while the database file is being written. Expected: on the next start the last good copy loads, never a half-written one. Pinned in Task 6.
3. The native HTTP layer ignores `AbortSignal.timeout`, so one hung request stalls a scan for ever. Expected: any outbound call that has not answered within its timeout rejects with a `TimeoutError`. Pinned in Task 7.
4. A save fires while a `BEGIN` has not reached `COMMIT`. Expected: the save waits until the transaction ends. Pinned in Tasks 2 and 6.
5. First launch on the phone, no database file yet. Expected: a fresh database with defaults, automatic Plex connection preselected. Pinned in Tasks 6 and 9.

---

### Task 1: Commit the work already in the tree

The tree holds two uncommitted pieces of work: air times (`src/airtimes.ts`, `tests/airtimes.test.ts`, and edits to `src/episodes.ts`, `src/api.ts`, `src/db.ts`, `src/watchlist.ts`, `public/*`, `tests/feed.test.ts`) and automatic remote connection (`src/plexconnect.ts`, `tests/plexconnect.test.ts`, `src/plex.ts`, `src/scanner.ts`, and edits to `src/api.ts`, `src/db.ts`, `src/watchlist.ts`, `public/app.js`, `public/index.html`).

**Files:** none changed; git history only.

- [ ] **Step 1: Run the full suite first**

Run: `npm run typecheck && npm test`
Expected: typecheck clean, 268 passing.

- [ ] **Step 2: Build the air-times-only index**

For each of the five overlapping files, write a script in the scratchpad that takes the working copy and reverses the remote-connection edits made in this session (the exact replacement pairs are in the session transcript: the `plexconnect` import and `/api/plex/servers` + auto branch of `/api/plex/test`, `tokenFrom`, the `ensurePlexUrl` block in settings POST, the `SETTABLE` additions in `api.ts`; the `plex_connection` and `plex_connection_kind` defaults in `db.ts`; the `plexconnect` import and the three `withPlex`/`ensurePlexUrl` blocks in `watchlist.ts`; the connection-mode code in `app.js`; the connection radios and auto/manual blocks in `index.html`). Stage each result without touching the working copy:

```bash
blob=$(git hash-object -w "$SCRATCH/air-only/src/api.ts")
git update-index --add --cacheinfo 100644,$blob,src/api.ts
```

Also `git add src/airtimes.ts tests/airtimes.test.ts src/episodes.ts tests/feed.test.ts public/feed.js public/styles.css`.

- [ ] **Step 3: Check the staged tree on its own**

Run: `git stash push --keep-index --include-untracked -m remote-wip && npm run typecheck && npm test; git stash pop`
Expected: typecheck clean and tests pass on the air-times-only tree, then the working copy is restored.

- [ ] **Step 4: Commit both**

```bash
git commit -m "Add broadcast air times from TVmaze"
git add -A src tests public
git commit -m "Find the Plex server automatically so it works away from home"
```

Both messages end with the `Co-Authored-By` line. Run `git status`; expected: clean apart from `docs/plans/`.

---

### Task 2: Database driver seam

**Files:**
- Create: `src/sqlite.ts` (the `Db` interface, no imports)
- Create: `src/sqlite-driver.ts` (PC driver, `node:sqlite`)
- Create: `src/sqlite-wasm.ts` (sql.js adapter, no Node imports)
- Modify: `src/db.ts:1-3,182-185`
- Modify: `package.json` (add `sql.js`, `@types/sql.js`)
- Test: `tests/sqlite.test.ts`

**Interfaces:**
- Produces: `type SqlValue = string | number | bigint | null | Uint8Array`; `interface Statement { get(...p: SqlValue[]): Record<string, unknown> | undefined; all(...p: SqlValue[]): Record<string, unknown>[]; run(...p: SqlValue[]): { changes: number; lastInsertRowid: number | bigint } }`; `interface Db { exec(sql: string): void; prepare(sql: string): Statement }`; `openNodeDatabase(path: string): Db`; `openDatabase(): Db`; `wrapSqlJs(raw: SqlJsDatabase, onWrite?: () => void): Db & { inTransaction(): boolean }`.

- [ ] **Step 1: Install**

Run: `npm install sql.js@1.14.2 && npm install -D @types/sql.js`

- [ ] **Step 2: Write the failing test**

`tests/sqlite.test.ts`:

```ts
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
    assert.deepEqual(rows.map((r) => r.name), ['a', 'c']);
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
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `node --test tests/sqlite.test.ts`
Expected: FAIL, cannot find `../src/sqlite-driver.ts`.

- [ ] **Step 4: Implement**

`src/sqlite.ts`:

```ts
/**
 * The slice of SQLite the app uses. The PC runs it on node:sqlite, the phone
 * on sql.js, and nothing outside the two drivers knows which.
 */
export type SqlValue = string | number | bigint | null | Uint8Array;

export interface Statement {
  get(...params: SqlValue[]): Record<string, unknown> | undefined;
  all(...params: SqlValue[]): Record<string, unknown>[];
  run(...params: SqlValue[]): { changes: number; lastInsertRowid: number | bigint };
}

export interface Db {
  exec(sql: string): void;
  prepare(sql: string): Statement;
}
```

`src/sqlite-driver.ts`:

```ts
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, ensureDataDir } from './config.ts';
import type { Db } from './sqlite.ts';

/** The PC driver. The phone build swaps this whole file for mobile/sqlite-driver.ts. */
export function openNodeDatabase(path: string): Db {
  const db = new DatabaseSync(path);
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  return db as unknown as Db;
}

export function openDatabase(): Db {
  ensureDataDir();
  return openNodeDatabase(DB_PATH);
}
```

`src/sqlite-wasm.ts`:

```ts
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
```

In `src/db.ts`, replace the `node:sqlite` and `config.ts` imports and the opening lines:

```ts
import { openDatabase } from './sqlite-driver.ts';
import type { Db } from './sqlite.ts';
...
export const db: Db = openDatabase();
db.exec(SCHEMA);
```

(remove `ensureDataDir();` and the `PRAGMA journal_mode` line; the PC driver does both).

- [ ] **Step 5: Run tests and typecheck**

Run: `node --test tests/sqlite.test.ts && npm run typecheck && npm test`
Expected: all pass. If typecheck flags a call site that relied on `node:sqlite` result types, cast at that call site with `as`, matching the file's existing style.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/sqlite.ts src/sqlite-driver.ts src/sqlite-wasm.ts src/db.ts tests/sqlite.test.ts
git commit -m "Put the database behind a driver so the phone can use sql.js"
```

---

### Task 3: Routing seam and shared start-up

**Files:**
- Create: `src/route.ts`, `src/startup.ts`
- Modify: `src/api.ts:34-45` (`readJson` without `Buffer`), `src/api.ts:783` (`new Uint8Array` instead of `Buffer.from`)
- Modify: `src/server.ts` (call `startBackgroundSync()`)
- Test: `tests/route.test.ts`

**Interfaces:**
- Produces: `route(method: string, url: URL, bodyText?: string): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }>`; `startBackgroundSync(): boolean` (true when a sync was started).

- [ ] **Step 1: Write the failing test**

`tests/route.test.ts`. It must not touch the real database, so it points the app at a temporary folder before anything imports `db.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PLEX_TRACKER_DATA_DIR = mkdtempSync(join(tmpdir(), 'pmt-route-'));
const { route } = await import('../src/route.ts');

const json = (r: { body: Uint8Array }) => JSON.parse(new TextDecoder().decode(r.body));
const u = (p: string) => new URL(`http://app${p}`);

test('a GET reaches the same handler the PC server uses', async () => {
  const r = await route('GET', u('/api/settings'));
  assert.equal(r.status, 200);
  assert.match(r.headers['Content-Type'] ?? '', /application\/json/);
  assert.equal(json(r).settings.plex_token, '');
});

test('a POST body is read and saved', async () => {
  const saved = await route('POST', u('/api/settings'), JSON.stringify({ recent_days: '30' }));
  assert.equal(saved.status, 200);
  assert.equal(json(await route('GET', u('/api/settings'))).settings.recent_days, '30');
});

test('an unknown endpoint is a JSON 404', async () => {
  const r = await route('GET', u('/api/nope'));
  assert.equal(r.status, 404);
  assert.equal(json(r).error, 'No such endpoint');
});

test('a path outside the API is a plain 404, not a crash', async () => {
  assert.equal((await route('GET', u('/index.html'))).status, 404);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --test tests/route.test.ts`
Expected: FAIL, cannot find `../src/route.ts`.

- [ ] **Step 3: Implement**

`readJson` in `src/api.ts`, keeping its existing size limit and error message:

```ts
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Uint8Array).length;
    // keep the existing limit check here unchanged
    chunks.push(chunk as Uint8Array);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  // keep the existing empty-body and parse-error handling, using:
  return JSON.parse(new TextDecoder().decode(all)) as Record<string, unknown>;
}
```

In `proxyThumb`: `res.end(new Uint8Array(await upstream.arrayBuffer()));`.

`src/route.ts`:

```ts
/**
 * The API without an HTTP server. The PC's server.ts and the phone's fetch
 * bridge both end up in handleApi; this gives the phone a way in that needs no
 * socket, by handing handleApi a request and response that only hold bytes.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleApi } from './api.ts';

export interface RouteResult {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export async function route(method: string, url: URL, bodyText = ''): Promise<RouteResult> {
  const req = {
    method,
    headers: {},
    async *[Symbol.asyncIterator]() {
      if (bodyText) yield new TextEncoder().encode(bodyText);
    },
  } as unknown as IncomingMessage;

  const out: RouteResult = { status: 200, headers: {}, body: new Uint8Array() };
  const res = {
    writeHead(status: number, headers: Record<string, string> = {}) {
      out.status = status;
      Object.assign(out.headers, headers);
      return res;
    },
    end(chunk?: string | Uint8Array) {
      if (typeof chunk === 'string') out.body = new TextEncoder().encode(chunk);
      else if (chunk) out.body = chunk;
      return res;
    },
  } as unknown as ServerResponse;

  const handled = await handleApi(req, res, url);
  if (!handled) return { status: 404, headers: {}, body: new Uint8Array() };
  return out;
}
```

`src/startup.ts` (moved out of `server.ts` so the phone shares it):

```ts
import { isConfigured, getSetting } from './db.ts';
import { runRefresh } from './scanner.ts';

/**
 * Catches up on the watchlist, episodes and library on every start. The slow
 * MusicBrainz scan is left for the Scan button.
 */
export function startBackgroundSync(): boolean {
  if (!isConfigured() || getSetting('sync_on_start') !== '1') return false;
  void runRefresh();
  return true;
}
```

In `src/server.ts`, replace the `if (isConfigured() && getSetting('sync_on_start') === '1') { ... }` block with:

```ts
  if (startBackgroundSync()) {
    process.stdout.write('  Syncing watchlist, episodes and library in the background\n\n');
  }
```

and drop the now-unused `runRefresh` and `getSetting` imports.

- [ ] **Step 4: Run tests, typecheck, and the real server**

Run: `node --test tests/route.test.ts && npm run typecheck && npm test`
Then start `npm start` in the background, `curl -s localhost:7000/api/settings` and `curl -s -o /dev/null -w "%{http_code}" "localhost:7000/thumb?key=missing"`.
Expected: tests pass; settings JSON returned; thumb returns 404.

- [ ] **Step 5: Commit**

```bash
git add src/route.ts src/startup.ts src/api.ts src/server.ts tests/route.test.ts
git commit -m "Let the API be called without an HTTP server"
```

---

### Task 4: GitHub repository

Done early so the spike APK and every later build have a download link.

**Files:**
- Modify: `.gitignore` (add `dist/`, `www/`, `*.jks`, `*.keystore`, `keystore.properties`, `android/app/build/`, `android/.gradle/`)
- Modify: `docs/specs/2026-09-27-android-app-design.md` (JDK 17 → JDK 21 from Android Studio, with the reason)

- [ ] **Step 1: Update `.gitignore` and the spec, commit**

```bash
git add .gitignore docs/specs/2026-09-27-android-app-design.md docs/plans/2026-09-27-android-app-plan.md
git commit -m "Ignore build output and keys; note JDK 21 for Capacitor 8"
```

- [ ] **Step 2: Create the repository in Chrome**

Open `https://github.com/new`. Read the signed-in account name from the page (this is `<owner>` from here on). Name `plex-media-tracker`, visibility Private, no README, no licence, no .gitignore. Confirm with the user in chat before pressing Create.

- [ ] **Step 3: Push**

```bash
git remote add origin https://github.com/<owner>/plex-media-tracker.git
git push -u origin main
```

Git Credential Manager may open a browser sign-in; the user completes it. Expected: `main` pushed. Check in Chrome that the repo page shows the files and is marked Private.

---

### Task 5: Capacitor scaffold, background service, and the spike

**Files:**
- Create: `capacitor.config.json`, `spike/index.html`
- Create (generated, then edited): `android/`
- Create: `android/app/src/main/java/com/nugggy/plexmediatracker/ScanService.kt`
- Create: `android/app/src/main/java/com/nugggy/plexmediatracker/ScanKeeperPlugin.kt`
- Modify: `android/app/src/main/java/com/nugggy/plexmediatracker/MainActivity.java` (becomes `.kt` or stays Java; register the plugin)
- Modify: `android/app/src/main/AndroidManifest.xml`
- Modify: `package.json` (Capacitor deps, `build:spike` script)

**Interfaces:**
- Produces (JS side of the plugin, used by Tasks 7 and 8): `ScanKeeper.start({ title: string, text: string }): Promise<void>`, `ScanKeeper.update({ text: string }): Promise<void>`, `ScanKeeper.stop(): Promise<void>`, `ScanKeeper.requestBatteryExemption(): Promise<{ granted: boolean }>`, event `tick` fired once a second while started.

- [ ] **Step 1: Install and scaffold**

```bash
npm install @capacitor/core@8.5.2 @capacitor/android@8.5.2 @capacitor/filesystem@8.1.3
npm install -D @capacitor/cli@8.5.2 esbuild@0.28.2
```

`capacitor.config.json`:

```json
{
  "appId": "com.nugggy.plexmediatracker",
  "appName": "Plex Media Tracker",
  "webDir": "www",
  "plugins": { "CapacitorHttp": { "enabled": true } }
}
```

Add to `package.json` scripts: `"build:spike": "node -e \"require('fs').rmSync('www',{recursive:true,force:true});require('fs').cpSync('spike','www',{recursive:true})\""`. Run `npm run build:spike && npx cap add android`.

- [ ] **Step 2: Manifest**

Inside `<manifest>`:

```xml
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
<uses-permission android:name="android.permission.WAKE_LOCK" />
<uses-permission android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS" />
```

Inside `<application>`:

```xml
<service android:name=".ScanService" android:exported="false" android:foregroundServiceType="dataSync" />
```

- [ ] **Step 3: The service**

`ScanService.kt`:

```kotlin
package com.nugggy.plexmediatracker

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/** Keeps the process, and so the web view's scan, alive with the screen off. */
class ScanService : Service() {
    companion object {
        const val CHANNEL = "scan"
        const val ID = 1
        @Volatile var running = false
    }

    private var lock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val title = intent?.getStringExtra("title") ?: "Plex Media Tracker"
        val text = intent?.getStringExtra("text") ?: "Checking for updates"
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, "Scans", NotificationManager.IMPORTANCE_LOW)
        )
        val n = notification(title, text)
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(ID, n)
        }
        if (lock == null) {
            lock = getSystemService(PowerManager::class.java)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "pmt:scan")
                .apply { acquire(2 * 60 * 60 * 1000L) }
        }
        running = true
        return START_NOT_STICKY
    }

    fun notification(title: String, text: String): Notification {
        val open = packageManager.getLaunchIntentForPackage(packageName)
        val pi = android.app.PendingIntent.getActivity(
            this, 0, open, android.app.PendingIntent.FLAG_IMMUTABLE
        )
        return Notification.Builder(this, CHANNEL)
            .setContentTitle(title)
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .setContentIntent(pi)
            .build()
    }

    override fun onDestroy() {
        running = false
        lock?.let { if (it.isHeld) it.release() }
        lock = null
        super.onDestroy()
    }
}
```

- [ ] **Step 4: The plugin**

`ScanKeeperPlugin.kt`:

```kotlin
package com.nugggy.plexmediatracker

import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "ScanKeeper")
class ScanKeeperPlugin : Plugin() {
    private val handler = Handler(Looper.getMainLooper())
    private var ticking = false
    private val tick = object : Runnable {
        override fun run() {
            if (!ticking) return
            notifyListeners("tick", JSObject())
            handler.postDelayed(this, 1000)
        }
    }

    @PluginMethod
    fun start(call: PluginCall) {
        val intent = Intent(context, ScanService::class.java)
            .putExtra("title", call.getString("title"))
            .putExtra("text", call.getString("text"))
        context.startForegroundService(intent)
        if (!ticking) {
            ticking = true
            handler.post(tick)
        }
        call.resolve()
    }

    @PluginMethod
    fun update(call: PluginCall) {
        if (ScanService.running) {
            val intent = Intent(context, ScanService::class.java)
                .putExtra("title", "Plex Media Tracker")
                .putExtra("text", call.getString("text"))
            context.startForegroundService(intent)
        }
        call.resolve()
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        ticking = false
        context.stopService(Intent(context, ScanService::class.java))
        call.resolve()
    }

    @PluginMethod
    fun requestBatteryExemption(call: PluginCall) {
        val pm = context.getSystemService(PowerManager::class.java)
        if (!pm.isIgnoringBatteryOptimizations(context.packageName)) {
            val i = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                .setData(Uri.parse("package:${context.packageName}"))
            activity.startActivity(i)
        }
        call.resolve(JSObject().put("granted", pm.isIgnoringBatteryOptimizations(context.packageName)))
    }
}
```

`MainActivity` (replace the generated file with Kotlin, same package):

```kotlin
package com.nugggy.plexmediatracker

import android.os.Bundle
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(ScanKeeperPlugin::class.java)
        super.onCreate(savedInstanceState)
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 1)
        }
    }

    /** While a scan runs, keep the web view awake when the app leaves the screen. */
    override fun onPause() {
        super.onPause()
        if (ScanService.running) {
            bridge.webView.onResume()
            bridge.webView.resumeTimers()
        }
    }

    override fun onStop() {
        super.onStop()
        if (ScanService.running) {
            bridge.webView.onResume()
            bridge.webView.resumeTimers()
        }
    }
}
```

If the generated project has no Kotlin plugin, add `id 'org.jetbrains.kotlin.android'` to `android/app/build.gradle` plugins and the matching classpath/version to `android/build.gradle`, using the Kotlin version the Android Gradle Plugin in the generated project expects.

- [ ] **Step 5: The spike page**

`spike/index.html` runs two measurements, chosen by button: "JS timers" (a `setTimeout` loop) and "Native ticks" (work on each `tick` event). Each loop does one MusicBrainz request a second, the scan's real pattern, and records every completion time in `localStorage`, so the result survives the screen being off. It shows elapsed seconds, expected count (elapsed), actual count, the ratio, and every gap longer than five seconds.

```html
<!doctype html>
<html lang="en-AU">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Background test</title>
<style>
  body { font: 16px system-ui; margin: 16px; background: #1e1a16; color: #eee; }
  button { font: inherit; padding: 12px; margin: 4px 0; width: 100%; }
  pre { white-space: pre-wrap; background: #2a241e; padding: 12px; }
</style>
</head>
<body>
<h1>Background test</h1>
<p>Set battery use for this app to Unrestricted first. Press a start button, lock the phone, wait 10 minutes, unlock, and read the result.</p>
<button id="js">Start: JS timers</button>
<button id="native">Start: Native ticks</button>
<button id="stop">Stop</button>
<pre id="out">Not started.</pre>
<script type="module">
const { Capacitor } = window;
const Keeper = Capacitor.Plugins.ScanKeeper;
const UA = 'PlexMediaTracker/1.2.0-spike ( local personal use )';
const MB = 'https://musicbrainz.org/ws/2/artist/5b11f4ce-a62d-471e-81fc-a69a8278c7da?fmt=json';
let mode = null, busy = false, timer = null, sub = null;

const load = () => JSON.parse(localStorage.getItem('spike') ?? 'null');
const save = (s) => localStorage.setItem('spike', JSON.stringify(s));

async function once() {
  if (busy) return;
  busy = true;
  try { await fetch(MB, { headers: { 'User-Agent': UA, Accept: 'application/json' } }); } catch {}
  const s = load(); s.done.push(Date.now()); save(s);
  busy = false;
}

function report() {
  const s = load();
  if (!s) return;
  const elapsed = Math.round(((s.stoppedAt ?? Date.now()) - s.startedAt) / 1000);
  const gaps = [];
  let prev = s.startedAt;
  for (const t of s.done) { if (t - prev > 5000) gaps.push(`${Math.round((t - prev) / 1000)} s at ${new Date(t).toLocaleTimeString('en-AU')}`); prev = t; }
  const ratio = elapsed ? Math.round((s.done.length / elapsed) * 100) : 0;
  document.getElementById('out').textContent =
    `Mode: ${s.mode}\nElapsed: ${elapsed} s\nExpected: ${elapsed}\nActual: ${s.done.length}\nRatio: ${ratio}%\n` +
    `Pass mark: 90% after 600 s\nGaps over 5 s: ${gaps.length ? '\n  ' + gaps.join('\n  ') : 'none'}`;
}

async function start(m) {
  save({ mode: m, startedAt: Date.now(), done: [], stoppedAt: null });
  mode = m;
  await Keeper.start({ title: 'Background test', text: `Running (${m})` });
  if (m === 'js') { const loop = async () => { await once(); timer = setTimeout(loop, 1000); }; loop(); }
  else { sub = await Keeper.addListener('tick', once); }
}

async function stop() {
  clearTimeout(timer); sub?.remove(); sub = null;
  await Keeper.stop();
  const s = load(); if (s) { s.stoppedAt = Date.now(); save(s); }
  report();
}

document.getElementById('js').onclick = () => start('js');
document.getElementById('native').onclick = () => start('native');
document.getElementById('stop').onclick = stop;
setInterval(report, 1000);
document.addEventListener('visibilitychange', report);
report();
</script>
</body>
</html>
```

- [ ] **Step 6: Build the spike APK**

```bash
export JAVA_HOME="/c/Program Files/Android/Android Studio/jbr"
export ANDROID_HOME="$LOCALAPPDATA/Android/Sdk"
npm run build:spike && npx cap sync android
(cd android && ./gradlew assembleDebug)
mkdir -p dist && cp android/app/build/outputs/apk/debug/app-debug.apk dist/plex-media-tracker-spike.apk
```

Expected: `BUILD SUCCESSFUL`, APK in `dist/`.

- [ ] **Step 7: Publish the spike for the phone**

With the user's go-ahead in chat, create a GitHub pre-release `spike-1` in Chrome at `https://github.com/<owner>/plex-media-tracker/releases/new`, attach `dist/plex-media-tracker-spike.apk`, and give the user the link. The project folder is also in OneDrive, so `dist/plex-media-tracker-spike.apk` is reachable from the OneDrive app on the phone as a fallback.

- [ ] **Step 8: Commit**

```bash
git add capacitor.config.json spike package.json package-lock.json android
git commit -m "Add the Android shell with a background scan service and a spike test page"
git push
```

- [ ] **Step 9: Decision gate (user runs the test)**

The user installs the APK, sets battery use to Unrestricted (Settings, Apps, Plex Media Tracker, Battery), runs each mode for 10 minutes with the screen off, and reports both results.

- JS timers pass (≥ 90% after 600 s): skip Task 5b.
- JS timers fail, native ticks pass: do Task 5b.
- Both fail: stop. Write up the results and move the scan into Kotlin under a new plan; do not continue this one.

---

### Task 5b (only if JS timers failed and native ticks passed): tick-driven sleep

**Files:**
- Create: `src/timing.ts`
- Modify: `src/musicbrainz.ts:27-29`, `src/episodes.ts:69-71`, `src/suggestions.ts:104-106` (use `sleep` from `timing.ts`)
- Test: `tests/timing.test.ts`

**Interfaces:**
- Produces: `sleep(ms: number): Promise<void>`; `setSleep(fn: (ms: number) => Promise<void>): void`; `tickSleep(onTick: (cb: () => void) => () => void, now?: () => number): (ms: number) => Promise<void>`.

- [ ] **Step 1: Failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tickSleep } from '../src/timing.ts';

test('a tick sleep ends on the first tick after the time is up', async () => {
  let t = 0;
  const listeners = new Set<() => void>();
  const onTick = (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); };
  const fire = () => [...listeners].forEach((cb) => cb());
  let done = false;
  const p = tickSleep(onTick, () => t)(1500).then(() => (done = true));
  t = 1000; fire(); await Promise.resolve();
  assert.equal(done, false);
  t = 2000; fire(); await p;
  assert.equal(done, true);
  assert.equal(listeners.size, 0);
});
```

- [ ] **Step 2: Run, expect FAIL (no module). Step 3: implement**

```ts
/** One sleep for the whole app, so the phone can swap in one driven by native ticks. */
let impl = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const sleep = (ms: number): Promise<void> => impl(ms);
export function setSleep(fn: (ms: number) => Promise<void>): void {
  impl = fn;
}

export function tickSleep(
  onTick: (cb: () => void) => () => void,
  now: () => number = Date.now,
): (ms: number) => Promise<void> {
  return (ms) =>
    new Promise((resolve) => {
      const until = now() + ms;
      const off = onTick(() => {
        if (now() >= until) {
          off();
          resolve();
        }
      });
    });
}
```

Replace the three local sleep functions with `import { sleep } from './timing.ts'`. In Task 8's `mobile/entry.ts`, add `setSleep(tickSleep((cb) => { const h = ScanKeeper.addListener('tick', cb); return () => void h.then((x) => x.remove()); }))`.

- [ ] **Step 4: Run all tests, commit** `"Drive sleeps from native ticks on the phone"`.

---

### Task 6: Phone database with safe saving

**Files:**
- Create: `mobile/persist.ts` (save scheduler, pure)
- Create: `mobile/storage.ts` (atomic file save and load over an injected file API, plus base64 helpers)
- Create: `mobile/sqlite-driver.ts` (replaces `src/sqlite-driver.ts` in the phone build)
- Create: `mobile/config.ts` (replaces `src/config.ts` in the phone build)
- Create: `src/version.ts`; Modify: `src/config.ts` (import `APP_VERSION` from it, add `PLATFORM = 'desktop'`)
- Modify: `src/db.ts` DEFAULTS (`plex_connection` defaults to `'auto'` when `PLATFORM === 'mobile'`)
- Modify: `tsconfig.json` (include `mobile`)
- Test: `tests/persist.test.ts`, `tests/storage.test.ts`

**Interfaces:**
- Consumes: `wrapSqlJs` from Task 2.
- Produces: `createSaver(opts: { save: () => Promise<void>; inTransaction: () => boolean; quietMs?: number; maxWaitMs?: number }): { markDirty(): void; flush(): Promise<void> }`; `interface FileApi { read(name: string): Promise<Uint8Array | null>; write(name: string, bytes: Uint8Array): Promise<void>; remove(name: string): Promise<void>; rename(from: string, to: string): Promise<void> }`; `saveDatabase(fs: FileApi, bytes: Uint8Array): Promise<void>`; `loadDatabase(fs: FileApi, isValid: (b: Uint8Array) => boolean): Promise<Uint8Array | null>`; `toBase64(b: Uint8Array): string`; `fromBase64(s: string): Uint8Array`; `initMobileDatabase(): Promise<void>`; `openDatabase(): Db`; `flushDatabase(): Promise<void>`; `APP_VERSION = '1.2.0'`; `PLATFORM: 'desktop' | 'mobile'`; `RELEASES_URL: string`.

- [ ] **Step 1: Failing tests for the scheduler**

`tests/persist.test.ts`:

```ts
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createSaver } from '../mobile/persist.ts';

const settle = () => new Promise((r) => setImmediate(r));

test('saves once things have been quiet for five seconds', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let saves = 0;
  const s = createSaver({ save: async () => void (saves += 1), inTransaction: () => false });
  s.markDirty();
  mock.timers.tick(4999); await settle();
  assert.equal(saves, 0);
  mock.timers.tick(1); await settle();
  assert.equal(saves, 1);
  mock.timers.reset();
});

test('keeps saving at least every 30 seconds while writes never stop', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let saves = 0;
  const s = createSaver({ save: async () => void (saves += 1), inTransaction: () => false });
  for (let i = 0; i < 70; i++) { s.markDirty(); mock.timers.tick(1000); await settle(); }
  assert.ok(saves >= 2, `saved ${saves} times in 70 s of constant writes`);
  mock.timers.reset();
});

test('never saves in the middle of a transaction', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let saves = 0;
  let open = true;
  const s = createSaver({ save: async () => void (saves += 1), inTransaction: () => open });
  s.markDirty();
  mock.timers.tick(10_000); await settle();
  assert.equal(saves, 0);
  open = false;
  mock.timers.tick(250); await settle();
  assert.equal(saves, 1);
  mock.timers.reset();
});

test('flush saves straight away when there is something to save, and not otherwise', async () => {
  let saves = 0;
  const s = createSaver({ save: async () => void (saves += 1), inTransaction: () => false });
  await s.flush();
  assert.equal(saves, 0);
  s.markDirty();
  await s.flush();
  assert.equal(saves, 1);
});
```

- [ ] **Step 2: Failing tests for storage**

`tests/storage.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveDatabase, loadDatabase, toBase64, fromBase64, type FileApi } from '../mobile/storage.ts';

function memFs(crashOn?: 'remove' | 'rename'): FileApi & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    async read(n) { return files.get(n) ?? null; },
    async write(n, b) { files.set(n, b); },
    async remove(n) { if (crashOn === 'remove') throw new Error('killed'); files.delete(n); },
    async rename(a, b) { if (crashOn === 'rename') throw new Error('killed'); files.set(b, files.get(a)!); files.delete(a); },
  };
}
const ok = () => true;
const bytes = (...n: number[]) => new Uint8Array(n);

test('first launch has nothing to load', async () => {
  assert.equal(await loadDatabase(memFs(), ok), null);
});

test('a save loads back identically', async () => {
  const fs = memFs();
  await saveDatabase(fs, bytes(1, 2, 3));
  assert.deepEqual(await loadDatabase(fs, ok), bytes(1, 2, 3));
});

test('killed after the old copy was removed: the new copy still loads', async () => {
  const fs = memFs();
  await saveDatabase(fs, bytes(1));
  const dying = memFs('rename');
  dying.files.set('tracker.db', bytes(1));
  await saveDatabase(dying, bytes(2)).catch(() => {});
  assert.deepEqual(await loadDatabase(dying, ok), bytes(2));
});

test('a half-written new copy is ignored in favour of the last good one', async () => {
  const fs = memFs();
  fs.files.set('tracker.db', bytes(1));
  fs.files.set('tracker.db.tmp', bytes(9));
  const valid = (b: Uint8Array) => b[0] !== 9;
  assert.deepEqual(await loadDatabase(fs, valid), bytes(1));
});

test('base64 round trip on a database-sized array', () => {
  const big = new Uint8Array(3_000_000).map((_, i) => i % 251);
  assert.deepEqual(fromBase64(toBase64(big)), big);
});
```

- [ ] **Step 3: Run both, expect FAIL (no modules)**

Run: `node --test tests/persist.test.ts tests/storage.test.ts`

- [ ] **Step 4: Implement**

`mobile/persist.ts`:

```ts
/**
 * When to write the phone's database to storage. Quiet for five seconds is the
 * normal trigger, but a scan writes every second for half an hour, so a save
 * also happens once thirty seconds of unsaved work have built up. Never in the
 * middle of a transaction.
 */
export function createSaver(opts: {
  save: () => Promise<void>;
  inTransaction: () => boolean;
  quietMs?: number;
  maxWaitMs?: number;
}): { markDirty(): void; flush(): Promise<void> } {
  const quiet = opts.quietMs ?? 5_000;
  const maxWait = opts.maxWaitMs ?? 30_000;
  let dirtySince: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let saving: Promise<void> | null = null;

  async function run(): Promise<void> {
    timer = null;
    if (dirtySince === null) return;
    if (opts.inTransaction()) {
      timer = setTimeout(run, 250);
      return;
    }
    if (saving) await saving;
    dirtySince = null;
    saving = opts.save().finally(() => (saving = null));
    await saving;
  }

  return {
    markDirty() {
      const now = Date.now();
      dirtySince ??= now;
      if (timer) clearTimeout(timer);
      const delay = Math.max(0, Math.min(quiet, maxWait - (now - dirtySince)));
      timer = setTimeout(run, delay);
    },
    async flush() {
      if (timer) clearTimeout(timer);
      await run();
    },
  };
}
```

`mobile/storage.ts`:

```ts
/**
 * Saving the database file so a kill at any moment leaves a loadable copy:
 * write the new copy beside the old, remove the old, rename the new. On load,
 * the main file wins; the side copy is used only when the main one is missing
 * and the side copy is a valid database.
 */
export interface FileApi {
  read(name: string): Promise<Uint8Array | null>;
  write(name: string, bytes: Uint8Array): Promise<void>;
  remove(name: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

const MAIN = 'tracker.db';
const SIDE = 'tracker.db.tmp';

export async function saveDatabase(fs: FileApi, bytes: Uint8Array): Promise<void> {
  await fs.write(SIDE, bytes);
  if (await fs.read(MAIN)) await fs.remove(MAIN);
  await fs.rename(SIDE, MAIN);
}

export async function loadDatabase(
  fs: FileApi,
  isValid: (b: Uint8Array) => boolean,
): Promise<Uint8Array | null> {
  const main = await fs.read(MAIN);
  if (main && isValid(main)) return main;
  const side = await fs.read(SIDE);
  if (side && isValid(side)) return side;
  return null;
}

export function toBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) {
    s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
```

The kill-after-remove test expects the side copy to load; `loadDatabase` does that because the main file is gone.

`mobile/sqlite-driver.ts`:

```ts
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
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void saver!.flush();
  });
}

export function openDatabase(): Db {
  if (!db) throw new Error('initMobileDatabase() has not run');
  return db;
}

export const flushDatabase = (): Promise<void> => saver?.flush() ?? Promise.resolve();
```

`src/version.ts`:

```ts
export const APP_VERSION = '1.2.0';
/** Filled in once the repository exists (Task 4). */
export const RELEASES_URL = 'https://github.com/<owner>/plex-media-tracker/releases/latest';
```

In `src/config.ts`: `import { APP_VERSION } from './version.ts'; export { APP_VERSION };` (replacing the literal) and `export const PLATFORM: 'desktop' | 'mobile' = 'desktop';`.

`mobile/config.ts` mirrors every export of `src/config.ts`:

```ts
import { APP_VERSION } from '../src/version.ts';
export { APP_VERSION };
export const APP_NAME = 'Plex Media Tracker';
export const PLATFORM: 'desktop' | 'mobile' = 'mobile';
export const DATA_DIR = '';
export const DB_PATH = '';
export const PORT = 0;
export const USER_AGENT = `PlexMediaTracker/${APP_VERSION} ( Android personal use )`;
export function ensureDataDir(): void {}
```

In `src/db.ts` DEFAULTS: `plex_connection: PLATFORM === 'mobile' ? 'auto' : 'manual',` with `import { PLATFORM } from './config.ts'`.

Add `"mobile"` to `tsconfig.json` `include` (and `"DOM"` to `lib` if it is not already there, since `mobile/` uses `document` and `MutationObserver`), and a `mobile/wasm.d.ts` with `declare module '*.wasm' { const url: string; export default url; }`.

- [ ] **Step 5: Run tests and typecheck**

Run: `node --test tests/persist.test.ts tests/storage.test.ts && npm run typecheck && npm test`
Expected: all pass. `mobile/sqlite-driver.ts` is typechecked but not executed in Node.

- [ ] **Step 6: Size check against the real database**

A scratchpad script that copies the live database safely (read-only, including the WAL) and times sql.js on it:

```ts
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import initSqlJs from 'sql.js';
const src = new DatabaseSync(`${process.env.LOCALAPPDATA}\\PlexMediaTracker\\plex-media-tracker.db`, { readOnly: true });
const out = `${process.env.TEMP}\\pmt-copy.db`;
src.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
const SQL = await initSqlJs();
let t = performance.now();
const db = new SQL.Database(readFileSync(out));
console.log('load ms', Math.round(performance.now() - t));
t = performance.now();
const bytes = db.export();
console.log('export ms', Math.round(performance.now() - t), 'bytes', bytes.length);
```

Expected: export well under a second on the PC. Report the numbers. If export exceeds 500 ms, raise `maxWaitMs` to 60 s before continuing.

- [ ] **Step 7: Commit**

```bash
git add mobile src/version.ts src/config.ts src/db.ts tsconfig.json tests/persist.test.ts tests/storage.test.ts
git commit -m "Phone database on sql.js, saved safely to app storage"
```

---

### Task 7: Fetch bridge and image swap

**Files:**
- Create: `mobile/bridge.ts`
- Test: `tests/bridge.test.ts`

**Interfaces:**
- Consumes: `route` shape from Task 3.
- Produces: `installFetchBridge(win: { fetch: typeof fetch; location: { origin: string } }, handle: (method: string, url: URL, body: string) => Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }>, opts?: { timeoutMs?: number }): void`; `installThumbSwap(doc: Document, fetchFn: typeof fetch): void`.

- [ ] **Step 1: Failing test**

```ts
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { installFetchBridge } from '../mobile/bridge.ts';

function fakeWin(real: typeof fetch) {
  return { fetch: real, location: { origin: 'https://localhost' } };
}

test('API calls go to the in-app router, not the network', async () => {
  let network = 0;
  const win = fakeWin((async () => { network += 1; return new Response(''); }) as typeof fetch);
  installFetchBridge(win, async (method, url, body) => ({
    status: 201,
    headers: { 'Content-Type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify({ method, path: url.pathname, body })),
  }));
  const r = await win.fetch('/api/settings', { method: 'POST', body: '{"a":1}' });
  assert.equal(r.status, 201);
  assert.deepEqual(await r.json(), { method: 'POST', path: '/api/settings', body: '{"a":1}' });
  assert.equal(network, 0);
});

test('everything else passes through to the real fetch', async () => {
  let seen = '';
  const win = fakeWin((async (u: string) => { seen = String(u); return new Response('ok'); }) as typeof fetch);
  installFetchBridge(win, async () => { throw new Error('should not route'); });
  await win.fetch('https://musicbrainz.org/ws/2/x');
  assert.equal(seen, 'https://musicbrainz.org/ws/2/x');
});

test('an outbound call that never answers fails with a TimeoutError', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const win = fakeWin((() => new Promise<Response>(() => {})) as typeof fetch);
  installFetchBridge(win, async () => { throw new Error('no'); }, { timeoutMs: 30_000 });
  const p = win.fetch('https://plex.tv/api/v2/user');
  mock.timers.tick(30_000);
  await assert.rejects(p, (e: Error) => e.name === 'TimeoutError');
  mock.timers.reset();
});
```

- [ ] **Step 2: Run, expect FAIL. Step 3: implement**

`mobile/bridge.ts`:

```ts
type Handle = (
  method: string,
  url: URL,
  body: string,
) => Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }>;

function isApp(url: URL, origin: string): boolean {
  return url.origin === origin && (url.pathname.startsWith('/api/') || url.pathname === '/thumb');
}

/**
 * The dashboard calls /api/... exactly as it does on the PC. Here those calls
 * never leave the app: they go straight to the router. Everything else goes
 * out through Capacitor's native HTTP, with a timer of our own, because the
 * native layer does not promise to honour an AbortSignal.
 */
export function installFetchBridge(
  win: { fetch: typeof fetch; location: { origin: string } },
  handle: Handle,
  opts: { timeoutMs?: number } = {},
): void {
  const real = win.fetch.bind(win);
  const timeoutMs = opts.timeoutMs ?? 60_000;

  win.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const href = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    const url = new URL(href, win.location.origin);
    if (isApp(url, win.location.origin)) {
      const body = typeof init.body === 'string' ? init.body : '';
      const r = await handle((init.method ?? 'GET').toUpperCase(), url, body);
      return new Response(r.body.length ? r.body : null, { status: r.status, headers: r.headers });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const e = new Error(`No answer from ${url.host} in ${timeoutMs / 1000} s`);
        e.name = 'TimeoutError';
        reject(e);
      }, timeoutMs);
    });
    try {
      return await Promise.race([real(input, init), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }) as typeof fetch;
}

/**
 * <img src="/thumb?..."> is loaded by the web view, not by fetch, so on the
 * phone it would hit the app's own file server and fail. Each one is fetched
 * through the bridge instead and swapped for a local copy.
 */
export function installThumbSwap(doc: Document, fetchFn: typeof fetch): void {
  const swap = async (img: HTMLImageElement) => {
    const src = img.getAttribute('src') ?? '';
    if (!src.startsWith('/thumb') || img.dataset.swapped === src) return;
    img.dataset.swapped = src;
    try {
      const r = await fetchFn(src);
      if (!r.ok) return;
      img.src = URL.createObjectURL(await r.blob());
    } catch {
      // A missing picture is not worth an error.
    }
  };
  const scan = (root: ParentNode) => root.querySelectorAll?.('img[src^="/thumb"]').forEach((i) => void swap(i as HTMLImageElement));
  new MutationObserver((changes) => {
    for (const c of changes) {
      if (c.type === 'attributes' && c.target instanceof HTMLImageElement) void swap(c.target);
      c.addedNodes.forEach((n) => {
        if (n instanceof HTMLImageElement) void swap(n);
        else if (n instanceof Element) scan(n);
      });
    }
  }).observe(doc.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });
  scan(doc);
}
```

Before relying on the swap, grep `public/app.js` and `public/styles.css` for `/thumb` used as a CSS `background-image`. If any exist, change them to `<img>` in `app.js`.

- [ ] **Step 4: Run all tests, commit** `"Route the dashboard's API calls inside the app on the phone"`.

---

### Task 8: Phone bundle, scan wiring, and the real APK

**Files:**
- Create: `mobile/entry.ts`, `scripts/build-mobile.mjs`
- Modify: `src/scanner.ts` (hooks around `runScan` and `runRefresh`)
- Modify: `package.json` (`build:mobile` script)

**Interfaces:**
- Consumes: `route`, `startBackgroundSync` (Task 3); `initMobileDatabase`, `flushDatabase` (Task 6); `installFetchBridge`, `installThumbSwap` (Task 7); `ScanKeeper` (Task 5).
- Produces: `scanHooks: { onStart(): void; onEnd(): void }` exported from `src/scanner.ts`, default no-ops.

- [ ] **Step 1: Scanner hooks**

In `src/scanner.ts`:

```ts
/** The phone uses these to keep a foreground service running during a check. */
export const scanHooks = { onStart: (): void => {}, onEnd: (): void => {} };
```

At the point in `runScan` and in `runRefresh` where `progress.running` becomes `true`, call `scanHooks.onStart()`; in the `finally` that sets `running = false`, call `scanHooks.onEnd()`. Add a test to an existing scanner-free test file only if one fits; otherwise this is covered by the on-device check in Task 10.

Run: `npm run typecheck && npm test`. Expected: pass.

- [ ] **Step 2: Entry point**

`mobile/entry.ts`:

```ts
import { registerPlugin } from '@capacitor/core';
import { installFetchBridge, installThumbSwap } from './bridge.ts';
import { initMobileDatabase, flushDatabase } from './sqlite-driver.ts';

interface ScanKeeperPlugin {
  start(o: { title: string; text: string }): Promise<void>;
  update(o: { text: string }): Promise<void>;
  stop(): Promise<void>;
  requestBatteryExemption(): Promise<{ granted: boolean }>;
}
const ScanKeeper = registerPlugin<ScanKeeperPlugin>('ScanKeeper');

// The bridge goes in first and synchronously, so the dashboard's first calls
// wait for the backend rather than going to the network.
const backend = initMobileDatabase().then(async () => {
  const [{ route }, { startBackgroundSync }, scanner] = await Promise.all([
    import('../src/route.ts'),
    import('../src/startup.ts'),
    import('../src/scanner.ts'),
  ]);

  let poll: ReturnType<typeof setInterval> | null = null;
  scanner.scanHooks.onStart = () => {
    void ScanKeeper.start({ title: 'Plex Media Tracker', text: 'Checking for updates' });
    if (localStorage.getItem('asked-battery') !== '1') {
      try { localStorage.setItem('asked-battery', '1'); } catch {}
      void ScanKeeper.requestBatteryExemption();
    }
    poll = setInterval(() => {
      const p = scanner.getProgress();
      void ScanKeeper.update({ text: p.message || 'Checking for updates' });
    }, 5000);
  };
  scanner.scanHooks.onEnd = () => {
    if (poll) clearInterval(poll);
    void flushDatabase();
    void ScanKeeper.stop();
  };

  startBackgroundSync();
  return route;
});

installFetchBridge(window, async (method, url, body) => (await backend)(method, url, body));
installThumbSwap(document, window.fetch);
```

- [ ] **Step 3: Build script**

`scripts/build-mobile.mjs`:

```js
import { build } from 'esbuild';
import { rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
rmSync(`${root}/www`, { recursive: true, force: true });
cpSync(`${root}/public`, `${root}/www`, { recursive: true });

// The two Node-only files are swapped for their phone versions.
const swaps = {
  [resolve(root, 'src/config.ts')]: resolve(root, 'mobile/config.ts'),
  [resolve(root, 'src/sqlite-driver.ts')]: resolve(root, 'mobile/sqlite-driver.ts'),
};
const swapPlugin = {
  name: 'swap',
  setup(b) {
    b.onResolve({ filter: /\.ts$/ }, (args) => {
      const full = resolve(args.resolveDir, args.path);
      return swaps[full] ? { path: swaps[full] } : undefined;
    });
  },
};

await build({
  entryPoints: [`${root}/mobile/entry.ts`],
  outdir: `${root}/www/mobile`,
  bundle: true,
  splitting: true,
  format: 'esm',
  target: 'es2022',
  platform: 'browser',
  loader: { '.wasm': 'file' },
  external: ['node:*'],
  plugins: [swapPlugin],
  logLevel: 'info',
});

const html = `${root}/www/index.html`;
writeFileSync(
  html,
  readFileSync(html, 'utf8').replace(
    '<script type="module" src="/app.js"></script>',
    '<script type="module" src="/mobile/entry.js"></script>\n    <script type="module" src="/app.js"></script>',
  ),
);
```

`external: ['node:*']` is a safety net: after building, `grep -l "node:" www/mobile/*.js` must print nothing. If it prints a file, a Node-only import leaked; find it with esbuild's `metafile` and remove it.

Add `"build:mobile": "node scripts/build-mobile.mjs"` to `package.json`.

- [ ] **Step 4: Build and install**

```bash
npm run build:mobile && grep -l "node:" www/mobile/*.js; npx cap sync android
(cd android && JAVA_HOME="/c/Program Files/Android/Android Studio/jbr" ANDROID_HOME="$LOCALAPPDATA/Android/Sdk" ./gradlew assembleDebug)
cp android/app/build/outputs/apk/debug/app-debug.apk dist/plex-media-tracker-1.2.0-debug.apk
```

Expected: the grep prints nothing; `BUILD SUCCESSFUL`.

- [ ] **Step 5: Smoke test in a desktop browser**

Serve `www/` with a static server (`npx http-server www -p 7100`), open it in Chrome, and check the console. Capacitor plugins are absent there, so `initMobileDatabase` fails at the Filesystem call. That is expected; the check is that the bundle loads, with no syntax or import errors before that point. Then give the user the debug APK through a `debug-1` pre-release, to confirm the dashboard opens, Settings shows automatic connection preselected, Find my servers lists Nuggy, and a quick check completes.

- [ ] **Step 6: Commit** `"Build the dashboard and backend into the Android app"`.

---

### Task 9: Download links and release signing

**Files:**
- Modify: `src/version.ts` (real `RELEASES_URL` with `<owner>` from Task 4)
- Modify: `src/api.ts` (`/api/settings` GET also returns `platform`, `version`, `releases_url`)
- Modify: `public/index.html`, `public/app.js` (an "Android app" fieldset)
- Modify: `android/app/build.gradle` (release signing from env or `keystore.properties`; `versionName "1.2.0"`, `versionCode 10200`)
- Create: `.github/workflows/android.yml`
- Test: extend `tests/route.test.ts`

- [ ] **Step 1: Failing test**

Add to `tests/route.test.ts`:

```ts
test('settings say which platform and version this is, and where releases live', async () => {
  const body = json(await route('GET', u('/api/settings')));
  assert.equal(body.platform, 'desktop');
  assert.equal(body.version, '1.2.0');
  assert.match(body.releases_url, /^https:\/\/github\.com\/[^/]+\/plex-media-tracker\/releases\/latest$/);
});

test('a fresh PC database keeps the typed-address connection', async () => {
  assert.equal(json(await route('GET', u('/api/settings'))).settings.plex_connection, 'manual');
});
```

- [ ] **Step 2: Run, expect FAIL. Step 3: implement**

In the `/api/settings` GET response add `platform: PLATFORM, version: APP_VERSION, releases_url: RELEASES_URL`.

`public/index.html`, a new fieldset after "Plex server":

```html
<fieldset>
  <legend>Android app</legend>
  <p class="muted small" id="app-version"></p>
  <p><a id="android-link" class="btn" target="_blank" rel="noopener">Get the Android app</a></p>
  <p class="muted small">
    The download needs you signed in to GitHub, because the repository is private.
  </p>
</fieldset>
```

In `loadSettings()` in `public/app.js`, after reading the response:

```js
    const { platform, version, releases_url } = response;
    $('#android-link').href = releases_url;
    $('#android-link').textContent =
      platform === 'mobile' ? 'Check for a newer version' : 'Get the Android app';
    $('#app-version').textContent =
      platform === 'mobile' ? `This is version ${version}.` : `Latest build is version ${version} or newer.`;
```

(change the destructuring at the top of `loadSettings` to `const response = await api('/api/settings'); const { settings, token_set } = response;`).

- [ ] **Step 4: Signing**

Generate the key once, outside the repo:

```bash
PASS=$(node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))")
"/c/Program Files/Android/Android Studio/jbr/bin/keytool" -genkeypair -keystore "$LOCALAPPDATA/PlexMediaTracker/android-release.jks" \
  -alias tracker -keyalg RSA -keysize 2048 -validity 10000 -storepass "$PASS" -keypass "$PASS" -dname "CN=Plex Media Tracker"
printf 'storeFile=%s\nstorePassword=%s\nkeyAlias=tracker\nkeyPassword=%s\n' \
  "$(cygpath -m "$LOCALAPPDATA/PlexMediaTracker/android-release.jks")" "$PASS" "$PASS" > android/keystore.properties
```

Do not print the password in chat. `android/keystore.properties` is ignored (Task 4).

In `android/app/build.gradle`:

```groovy
def ksProps = new Properties()
def ksFile = rootProject.file('keystore.properties')
if (ksFile.exists()) ksProps.load(new FileInputStream(ksFile))

android {
    defaultConfig {
        versionCode 10200
        versionName "1.2.0"
    }
    signingConfigs {
        release {
            storeFile file(System.getenv('PMT_KEYSTORE') ?: ksProps['storeFile'])
            storePassword System.getenv('PMT_KEYSTORE_PASSWORD') ?: ksProps['storePassword']
            keyAlias 'tracker'
            keyPassword System.getenv('PMT_KEYSTORE_PASSWORD') ?: ksProps['keyPassword']
        }
    }
    buildTypes {
        release { signingConfig signingConfigs.release }
    }
}
```

Merge these into the generated blocks rather than adding duplicates.

- [ ] **Step 5: Build the release APK locally**

```bash
npm run build:mobile && npx cap sync android
(cd android && JAVA_HOME="/c/Program Files/Android/Android Studio/jbr" ANDROID_HOME="$LOCALAPPDATA/Android/Sdk" ./gradlew assembleRelease)
cp android/app/build/outputs/apk/release/app-release.apk dist/plex-media-tracker-1.2.0.apk
"$LOCALAPPDATA/Android/Sdk/build-tools/36.1.0/apksigner.bat" verify --print-certs dist/plex-media-tracker-1.2.0.apk
```

Expected: `BUILD SUCCESSFUL`; `apksigner` prints `CN=Plex Media Tracker`.

The debug build from Task 8 is signed with a different key, so Android will not update it in place. The user uninstalls the debug build first. The phone's database from the debug build is lost, which is acceptable because it was a test install.

- [ ] **Step 6: Workflow**

`.github/workflows/android.yml`:

```yaml
name: Android release
on:
  push:
    tags: ['v*']
permissions:
  contents: write
jobs:
  apk:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '24', cache: npm }
      - uses: actions/setup-java@v4
        with: { distribution: temurin, java-version: '21' }
      - run: npm ci
      - run: npm run typecheck && npm test
      - run: npm run build:mobile && npx cap sync android
      - name: Decode keystore
        run: echo "${{ secrets.PMT_KEYSTORE_B64 }}" | base64 -d > "$RUNNER_TEMP/release.jks"
      - name: Build
        working-directory: android
        env:
          PMT_KEYSTORE: ${{ runner.temp }}/release.jks
          PMT_KEYSTORE_PASSWORD: ${{ secrets.PMT_KEYSTORE_PASSWORD }}
        run: ./gradlew assembleRelease
      - run: cp android/app/build/outputs/apk/release/app-release.apk "plex-media-tracker-${GITHUB_REF_NAME#v}.apk"
      - uses: softprops/action-gh-release@v2
        with:
          files: plex-media-tracker-*.apk
```

- [ ] **Step 7: Secrets (user)**

Write the base64 keystore to a scratchpad file (`base64 -w0 android-release.jks > $SCRATCH/keystore.b64`) and tell the user where it and the password (in `android/keystore.properties`) are. The user adds `PMT_KEYSTORE_B64` and `PMT_KEYSTORE_PASSWORD` at `https://github.com/<owner>/plex-media-tracker/settings/secrets/actions`. The agent does not enter them. Delete the scratchpad file once the user confirms.

- [ ] **Step 8: Tests, commit, tag, release**

Run: `npm run typecheck && npm test`

```bash
git add src/version.ts src/api.ts public/index.html public/app.js android/app/build.gradle .github tests/route.test.ts
git commit -m "Signed Android release builds with download links in both apps"
git push && git tag v1.2.0 && git push origin v1.2.0
```

Watch the run in Chrome at `https://github.com/<owner>/plex-media-tracker/actions`. Expected: green, and a `v1.2.0` release carrying `plex-media-tracker-1.2.0.apk`. Check that the release APK's certificate matches the local one (`apksigner verify --print-certs` on the downloaded file). If the workflow fails, the locally built `dist/plex-media-tracker-1.2.0.apk` can be attached to the release by hand in the meantime.

---

### Task 10: On-phone verification

User-run, guided in chat. Each step has a pass condition.

- [ ] Install `plex-media-tracker-1.2.0.apk` from the release link (uninstall the debug build first). Pass: it opens on the dashboard.
- [ ] Settings: paste the token, Find my servers, Test connection, Save. Pass: "Reached on your home network" on Wi-Fi.
- [ ] Wi-Fi off, mobile data on, Test connection. Pass: "Reached over the internet".
- [ ] Check for updates, then lock the phone for the MusicBrainz step. Pass: the notification shows progress, and the scan finishes with the screen off.
- [ ] Swipe the app away mid-scan, reopen. Pass: artists already checked are still there, at most about 30 seconds of work lost.
- [ ] Settings: Check for a newer version opens the releases page.
