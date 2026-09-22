# Trending implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Trending tab showing what is popular now in films, television and US country music, with a trailer or play button on every row and a one-press path onto the Plex watchlist or the watched artist list.

**Architecture:** One new server module, `src/trending.ts`, owns all four sources, resolves each chart row to an identifier the rest of the app already understands, and caches the result in SQLite. The build runs in the background behind a progress endpoint, exactly as Suggestions does. The browser gets a tab built from the existing card pattern, with the catalogue filter applied client side like the Cinema tickbox.

**Tech Stack:** Node 24 with type stripping, no build step, no runtime dependencies. `node:sqlite` for storage, `node:test` for tests. TMDB and the Apple iTunes RSS chart over plain `fetch`.

**Spec:** `docs/specs/2026-09-19-trending-design.md`

## Global constraints

- Australian English in all user-facing copy. No em dashes anywhere.
- No new runtime dependencies. Node 24 built-ins only.
- The Plex token and the TMDB key never reach the browser. Artwork is proxied.
- Dates are compared in Australia/Sydney via `src/dates.ts`, never in UTC.
- MusicBrainz allows one request per second. Use the existing limiter in `src/musicbrainz.ts`; never call it in a bare loop.
- Charts run 50 deep. Singles are off by default. Catalogue means released more than 12 months ago.
- Every test is pure. No test makes a network call.
- Run `npm test` and `npm run typecheck` before every commit.

---

### Task 1: Parse the Apple chart

**Files:**
- Create: `src/trending.ts`
- Test: `tests/trending.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface ChartRow { kind: 'album' | 'single'; id: string; rank: number; title: string; subtitle: string; release_date: string | null; thumb: string | null; link: string | null; }` and `parseAppleChart(raw: unknown, kind: 'album' | 'single'): ChartRow[]`.

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAppleChart } from '../src/trending.ts';

/** An album entry. Apple gives albums a single link object. */
const albumEntry = {
  'im:name': { label: "That's Just Me" },
  'im:artist': { label: 'Riley Green' },
  'im:image': [
    { label: 'https://is1-ssl.mzstatic.com/a/55x55bb.png', attributes: { height: '55' } },
    { label: 'https://is1-ssl.mzstatic.com/a/170x170bb.png', attributes: { height: '170' } },
  ],
  'im:releaseDate': { label: '2026-09-18T00:00:00-07:00' },
  id: { attributes: { 'im:id': '6770725355' } },
  link: { attributes: { href: 'https://music.apple.com/us/album/thats-just-me/6770725355' } },
};

/** A song entry. Apple gives songs an array of links instead. */
const songEntry = {
  ...albumEntry,
  link: [{ attributes: { href: 'https://music.apple.com/us/album/last-thing/6812476961' } }],
};

const feed = (entries: unknown[]) => ({ feed: { entry: entries } });

test('an album entry becomes a chart row', () => {
  const rows = parseAppleChart(feed([albumEntry]), 'album');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.title, "That's Just Me");
  assert.equal(rows[0]!.subtitle, 'Riley Green');
  assert.equal(rows[0]!.kind, 'album');
});

test('chart position is kept, counting from one', () => {
  const rows = parseAppleChart(feed([albumEntry, songEntry]), 'album');
  assert.deepEqual(rows.map((r) => r.rank), [1, 2]);
});

test('the release date is reduced to a plain calendar date', () => {
  assert.equal(parseAppleChart(feed([albumEntry]), 'album')[0]!.release_date, '2026-09-18');
});

test('the largest artwork is chosen, not the first', () => {
  assert.equal(
    parseAppleChart(feed([albumEntry]), 'album')[0]!.thumb,
    'https://is1-ssl.mzstatic.com/a/170x170bb.png',
  );
});

test('a song link arrives as an array where an album link is an object', () => {
  const album = parseAppleChart(feed([albumEntry]), 'album')[0]!;
  const song = parseAppleChart(feed([songEntry]), 'single')[0]!;
  assert.equal(album.link, 'https://music.apple.com/us/album/thats-just-me/6770725355');
  assert.equal(song.link, 'https://music.apple.com/us/album/last-thing/6812476961');
});

test('an entry with no title is skipped rather than throwing', () => {
  assert.equal(parseAppleChart(feed([{ 'im:artist': { label: 'Someone' } }]), 'album').length, 0);
});

test('a feed with no entries yields nothing rather than throwing', () => {
  assert.deepEqual(parseAppleChart({ feed: {} }, 'album'), []);
  assert.deepEqual(parseAppleChart(null, 'album'), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with `Cannot find module '.../src/trending.ts'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/trending.ts`:

```ts
/**
 * What is popular right now, as opposed to what is coming for things already
 * followed. Films and television come from TMDB weekly trending; country music
 * comes from the Apple iTunes RSS chart, which needs no API key.
 *
 * The design and the sources that were rejected are written up in
 * docs/specs/2026-09-19-trending-design.md.
 */

export type TrendingKind = 'movie' | 'show' | 'album' | 'single';

export interface ChartRow {
  kind: TrendingKind;
  id: string;
  rank: number;
  title: string;
  subtitle: string;
  release_date: string | null;
  thumb: string | null;
  link: string | null;
}

interface AppleEntry {
  'im:name'?: { label?: string };
  'im:artist'?: { label?: string };
  'im:image'?: { label?: string }[];
  'im:releaseDate'?: { label?: string };
  id?: { attributes?: { 'im:id'?: string } };
  link?: { attributes?: { href?: string } } | { attributes?: { href?: string } }[];
}

/** Apple links an album with one object and a song with an array of them. */
function firstHref(link: AppleEntry['link']): string | null {
  const one = Array.isArray(link) ? link[0] : link;
  return one?.attributes?.href ?? null;
}

export function parseAppleChart(raw: unknown, kind: 'album' | 'single'): ChartRow[] {
  const entries = (raw as { feed?: { entry?: AppleEntry[] } })?.feed?.entry;
  if (!Array.isArray(entries)) return [];

  const out: ChartRow[] = [];
  for (const e of entries) {
    const title = e['im:name']?.label;
    if (!title) continue;
    const images = e['im:image'] ?? [];
    out.push({
      kind,
      id: e.id?.attributes?.['im:id'] ?? title,
      rank: out.length + 1,
      title,
      subtitle: e['im:artist']?.label ?? '',
      release_date: e['im:releaseDate']?.label?.slice(0, 10) ?? null,
      thumb: images[images.length - 1]?.label ?? null,
      link: firstHref(e.link),
    });
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` then `npm run typecheck`
Expected: all tests PASS, typecheck silent.

- [ ] **Step 5: Commit**

```bash
git add src/trending.ts tests/trending.test.ts
git commit -m "feat(trending): parse the Apple country chart"
```

---

### Task 2: The catalogue rule

**Files:**
- Modify: `public/feed.js` (append a new section at the end)
- Test: `tests/feed.test.ts` (append)

**Interfaces:**
- Consumes: nothing.
- Produces: `isCatalogue(row, now)` and `filterCatalogue(rows, includeCatalogue, now)` exported from `public/feed.js`. A row is any object with a `release_date` string or null.

- [ ] **Step 1: Write the failing test**

Append to `tests/feed.test.ts`, and add `isCatalogue` and `filterCatalogue` to the import list at the top of that file:

```ts
/* ------------------------------------------------------- the catalogue rule */

const chart = (over: Record<string, unknown> = {}) => ({
  kind: 'album',
  title: 'A Record',
  release_date: '2026-09-01',
  ...over,
});

test('a record from this month is not catalogue', () => {
  assert.equal(isCatalogue(chart(), NOW), false);
});

test('a record from eleven months ago is not yet catalogue', () => {
  assert.equal(isCatalogue(chart({ release_date: '2025-11-01' }), NOW), false);
});

test('a record from more than a year ago is catalogue', () => {
  assert.equal(isCatalogue(chart({ release_date: '1973-09-01' }), NOW), true);
});

test('a record with no date is never catalogue', () => {
  assert.equal(isCatalogue(chart({ release_date: null }), NOW), false);
});

test('catalogue is hidden by default and returned when asked for', () => {
  const rows = [chart({ release_date: '1973-09-01' }), chart()];
  assert.equal(filterCatalogue(rows, false, NOW).length, 1);
  assert.equal(filterCatalogue(rows, true, NOW).length, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with `does not provide an export named 'isCatalogue'`.

- [ ] **Step 3: Write minimal implementation**

Append to `public/feed.js`:

```js
/** A year is the line between what is new and what is back catalogue. */
const CATALOGUE_DAYS = 365;

/**
 * Thirty of the top fifty country albums are usually older than a year, so
 * without this the tab is mostly records you have owned for decades. A row
 * with no date is never catalogue: Apple omits the date on some brand new
 * singles, and hiding something new for want of a date is the worse error.
 */
export function isCatalogue(row, now = new Date()) {
  if (!row.release_date) return false;
  const released = new Date(`${row.release_date}T00:00:00`).getTime();
  return now.getTime() - released > CATALOGUE_DAYS * 86400000;
}

export function filterCatalogue(rows, includeCatalogue, now = new Date()) {
  return includeCatalogue ? rows : rows.filter((r) => !isCatalogue(r, now));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add public/feed.js tests/feed.test.ts
git commit -m "feat(trending): hide back catalogue behind a toggle"
```

---

### Task 3: Match a chart title to a Plex Discover result

**Files:**
- Modify: `src/search.ts` (export a scorer and a single-title lookup)
- Test: `tests/search.test.ts` (create)

**Interfaces:**
- Consumes: the existing `discoverSearch` internals in `src/search.ts`.
- Produces: `scoreDiscoverMatch(hit: {title: string; year: number | null}, want: {title: string; year: number | null}): number` and `findDiscoverMatch(title: string, year: number | null, token: string): Promise<{ratingKey: string; guid: string} | null>` exported from `src/search.ts`.

- [ ] **Step 1: Write the failing test**

Create `tests/search.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreDiscoverMatch } from '../src/search.ts';

const want = { title: 'Wicked', year: 2026 };

test('an exact title and year is the strongest match', () => {
  assert.ok(scoreDiscoverMatch({ title: 'Wicked', year: 2026 }, want) > 0);
});

test('a different title never matches, however close the year', () => {
  assert.equal(scoreDiscoverMatch({ title: 'Wicked Games', year: 2026 }, want), 0);
});

test('a year one out still matches, since sources disagree on release year', () => {
  assert.ok(scoreDiscoverMatch({ title: 'Wicked', year: 2025 }, want) > 0);
});

test('the right title in the wrong decade does not match', () => {
  assert.equal(scoreDiscoverMatch({ title: 'Wicked', year: 1998 }, want), 0);
});

test('the same year outranks a year that is merely close', () => {
  const exact = scoreDiscoverMatch({ title: 'Wicked', year: 2026 }, want);
  const near = scoreDiscoverMatch({ title: 'Wicked', year: 2025 }, want);
  assert.ok(exact > near);
});

test('case and punctuation do not matter', () => {
  assert.ok(scoreDiscoverMatch({ title: 'WICKED!', year: 2026 }, want) > 0);
});

test('a missing year on either side still allows a title match', () => {
  assert.ok(scoreDiscoverMatch({ title: 'Wicked', year: null }, want) > 0);
  assert.ok(scoreDiscoverMatch({ title: 'Wicked', year: 2026 }, { title: 'Wicked', year: null }) > 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with `does not provide an export named 'scoreDiscoverMatch'`.

- [ ] **Step 3: Write minimal implementation**

Add to `src/search.ts`:

```ts
/** Folds a title so punctuation and case stop mattering. */
function foldTitle(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * How well a Discover result answers a chart row. The title has to be exact
 * once folded, because a near miss here puts the wrong film on the watchlist.
 * Years are allowed to differ by one, since TMDB and Plex disagree about
 * films released either side of New Year.
 */
export function scoreDiscoverMatch(
  hit: { title: string; year: number | null },
  want: { title: string; year: number | null },
): number {
  if (foldTitle(hit.title) !== foldTitle(want.title)) return 0;
  if (hit.year === null || want.year === null) return 5;
  const gap = Math.abs(hit.year - want.year);
  if (gap === 0) return 10;
  if (gap === 1) return 7;
  return 0;
}

/** One title, resolved to the key the watchlist actually needs. */
export async function findDiscoverMatch(
  title: string,
  year: number | null,
  token: string,
): Promise<{ ratingKey: string; guid: string } | null> {
  const hits = await discoverSearch(title, token);
  let best: { ratingKey: string; guid: string; score: number } | null = null;
  for (const h of hits) {
    const score = scoreDiscoverMatch({ title: h.title, year: h.year }, { title, year });
    if (score > 0 && (!best || score > best.score)) {
      best = {
        ratingKey: h.id,
        guid: `plex://${h.kind}/${h.id}`,
        score,
      };
    }
  }
  return best ? { ratingKey: best.ratingKey, guid: best.guid } : null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` then `npm run typecheck`
Expected: PASS and silent.

- [ ] **Step 5: Commit**

```bash
git add src/search.ts tests/search.test.ts
git commit -m "feat(trending): resolve one chart title to a Plex Discover key"
```

---

### Task 4: Cache the artist to MusicBrainz ID mapping

**Files:**
- Modify: `src/trending.ts`
- Test: `tests/trending.test.ts` (append)

**Interfaces:**
- Consumes: `normaliseArtistName` from `src/matching.ts`, `searchArtist` from `src/musicbrainz.ts`, `db` from `src/db.ts`, `nowIso` from `src/dates.ts`.
- Produces: `pickArtistMatch(candidates: {id: string; name: string; score: number}[], wanted: string): string | null` and `resolveArtist(name: string): Promise<string | null>` from `src/trending.ts`.

- [ ] **Step 1: Write the failing test**

Append to `tests/trending.test.ts`, adding `pickArtistMatch` to the import at the top:

```ts
/* ------------------------------------------------------- artist resolution */

const mb = (name: string, score = 100, id = name.toLowerCase()) => ({ id, name, score });

test('the artist whose name matches is chosen', () => {
  const picked = pickArtistMatch([mb('Someone Else'), mb('Riley Green')], 'Riley Green');
  assert.equal(picked, 'riley green');
});

test('case and punctuation in the chart name do not matter', () => {
  assert.equal(pickArtistMatch([mb('Morgan Wallen')], 'MORGAN WALLEN!'), 'morgan wallen');
});

test('a weak MusicBrainz score is refused rather than guessed at', () => {
  assert.equal(pickArtistMatch([mb('Riley Green', 40)], 'Riley Green'), null);
});

test('no candidate at all gives nothing rather than throwing', () => {
  assert.equal(pickArtistMatch([], 'Riley Green'), null);
});

test('a name that does not match is refused even when it scores well', () => {
  assert.equal(pickArtistMatch([mb('Riley Greene')], 'Riley Green'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with `does not provide an export named 'pickArtistMatch'`.

- [ ] **Step 3: Write minimal implementation**

Add to `src/trending.ts`:

```ts
import { db } from './db.ts';
import { nowIso } from './dates.ts';
import { normaliseArtistName } from './matching.ts';
import { searchArtist } from './musicbrainz.ts';

const ARTIST_CACHE = `
CREATE TABLE IF NOT EXISTS artist_mbid_cache (
  name_folded TEXT PRIMARY KEY,
  mbid        TEXT,
  looked_up   TEXT NOT NULL
);`;
db.exec(ARTIST_CACHE);

/** Matching the YouTube cache, for the same reason: answers barely move. */
const ARTIST_CACHE_DAYS = 14;

/** MusicBrainz scores below this are guesses, and a guess here mistracks. */
const MIN_ARTIST_SCORE = 70;

/**
 * The chart gives a name and nothing else, so the name has to be exact once
 * folded. Watching the wrong artist is silent and hard to notice, so refusing
 * is better than guessing.
 */
export function pickArtistMatch(
  candidates: { id: string; name: string; score: number }[],
  wanted: string,
): string | null {
  const want = normaliseArtistName(wanted);
  for (const c of candidates) {
    if (c.score >= MIN_ARTIST_SCORE && normaliseArtistName(c.name) === want) return c.id;
  }
  return null;
}

/**
 * MusicBrainz allows one request per second, so the chart's hundred rows would
 * be a hundred seconds. The chart repeats artists heavily and the answer is
 * cached by folded name, so in practice a rebuild costs seconds.
 */
export async function resolveArtist(name: string): Promise<string | null> {
  const folded = normaliseArtistName(name);
  if (!folded) return null;

  const row = db
    .prepare('SELECT mbid, looked_up FROM artist_mbid_cache WHERE name_folded = ?')
    .get(folded) as { mbid: string | null; looked_up: string } | undefined;
  if (row && Date.now() - Date.parse(row.looked_up) < ARTIST_CACHE_DAYS * 86_400_000) {
    return row.mbid;
  }

  let mbid: string | null = null;
  try {
    mbid = pickArtistMatch(await searchArtist(name), name);
  } catch {
    // A failed lookup is cached as nothing, and retried after the fortnight.
  }
  db.prepare(
    `INSERT INTO artist_mbid_cache (name_folded, mbid, looked_up) VALUES (?, ?, ?)
     ON CONFLICT(name_folded) DO UPDATE SET mbid = excluded.mbid, looked_up = excluded.looked_up`,
  ).run(folded, mbid, nowIso());
  return mbid;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` then `npm run typecheck`
Expected: PASS and silent.

- [ ] **Step 5: Commit**

```bash
git add src/trending.ts tests/trending.test.ts
git commit -m "feat(trending): resolve and cache chart artists against MusicBrainz"
```

---

### Task 5: Fetch the four charts

**Files:**
- Modify: `src/tmdb.ts` (trending calls), `src/trending.ts` (Apple fetch)

**Interfaces:**
- Consumes: `parseAppleChart` from Task 1.
- Produces: `trendingFromTmdb(kind: 'movie' | 'show', key: string): Promise<ChartRow[]>` from `src/tmdb.ts`, and `trendingFromApple(kind: 'album' | 'single'): Promise<ChartRow[]>` from `src/trending.ts`.

There is no test in this task. Both functions are a `fetch` and a parse, and the parse is already covered by Task 1. Checking them means calling the live services, which the existing modules are also checked by hand.

- [ ] **Step 1: Add the TMDB trending calls**

Add to `src/tmdb.ts`:

```ts
import type { ChartRow } from './trending.ts';

/** The chart runs 50 deep and TMDB pages 20 at a time. */
const CHART_DEPTH = 50;
const TMDB_IMAGE = 'https://image.tmdb.org/t/p/w342';

interface TmdbTrendingItem {
  id?: number;
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  poster_path?: string;
}

export async function trendingFromTmdb(
  kind: 'movie' | 'show',
  key: string,
): Promise<ChartRow[]> {
  const path = kind === 'show' ? 'tv' : 'movie';
  const rows: ChartRow[] = [];

  for (let page = 1; page <= 3 && rows.length < CHART_DEPTH; page += 1) {
    const res = await fetch(`${API}/trending/${path}/week?api_key=${key}&page=${page}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 401) throw new Error('TMDB rejected the API key.');
    if (!res.ok) break;

    const data = (await res.json()) as { results?: TmdbTrendingItem[] };
    for (const r of data.results ?? []) {
      const title = r.title ?? r.name;
      if (!r.id || !title) continue;
      if (rows.length >= CHART_DEPTH) break;
      rows.push({
        kind,
        id: String(r.id),
        rank: rows.length + 1,
        title,
        subtitle: '',
        release_date: (r.release_date ?? r.first_air_date ?? '').slice(0, 10) || null,
        thumb: r.poster_path ? `${TMDB_IMAGE}${r.poster_path}` : null,
        link: `https://www.themoviedb.org/${path}/${r.id}`,
      });
    }
  }
  return rows;
}
```

- [ ] **Step 2: Add the Apple fetch**

Add to `src/trending.ts`:

```ts
/** Genre 6 is Country. The US chart leads the Australian one. */
const APPLE_CHART = (what: string) =>
  `https://itunes.apple.com/us/rss/${what}/limit=50/genre=6/json`;

export async function trendingFromApple(kind: 'album' | 'single'): Promise<ChartRow[]> {
  const res = await fetch(APPLE_CHART(kind === 'album' ? 'topalbums' : 'topsongs'), {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Apple returned HTTP ${res.status}`);
  return parseAppleChart(await res.json(), kind);
}
```

- [ ] **Step 3: Verify against the live services**

Run:

```bash
node -e "import('./src/trending.ts').then(async m => { const r = await m.trendingFromApple('album'); console.log(r.length, r[0]); })"
```

Expected: 50 rows, the first carrying a rank of 1, a title, an artist and an artwork URL.

- [ ] **Step 4: Run the suite and typecheck**

Run: `npm test` then `npm run typecheck`
Expected: PASS and silent.

- [ ] **Step 5: Commit**

```bash
git add src/tmdb.ts src/trending.ts
git commit -m "feat(trending): fetch the TMDB and Apple charts"
```

---

### Task 6: Store the built chart

**Files:**
- Modify: `src/trending.ts`
- Test: `tests/trending.test.ts` (append)

**Interfaces:**
- Consumes: `ChartRow` from Task 1.
- Produces: `interface TrendingRow extends ChartRow { rating_key: string | null; guid: string | null; mbid: string | null; tracked: boolean; in_library: boolean; }`, plus `saveTrending(rows)`, `listTrending(): TrendingRow[]`, `hideTrending(kind, id, hidden)`, `builtAt(): string | null`, and `mergeHidden(rows, hidden): TrendingRow[]`.

- [ ] **Step 1: Write the failing test**

Append to `tests/trending.test.ts`, adding `mergeHidden` to the import:

```ts
/* ------------------------------------------------------------ hidden rows */

const stored = (over: Record<string, unknown> = {}) => ({
  kind: 'album',
  id: '1',
  rank: 1,
  title: 'A Record',
  subtitle: 'An Artist',
  release_date: '2026-09-01',
  thumb: null,
  link: null,
  rating_key: null,
  guid: null,
  mbid: null,
  tracked: false,
  in_library: false,
  ...over,
});

test('a row the user hid is dropped after a rebuild', () => {
  const rows = mergeHidden([stored()], new Set(['album:1']));
  assert.equal(rows.length, 0);
});

test('hiding one row leaves the others alone', () => {
  const rows = mergeHidden([stored(), stored({ id: '2' })], new Set(['album:1']));
  assert.deepEqual(rows.map((r) => r.id), ['2']);
});

test('the same id under a different kind is a different row', () => {
  const rows = mergeHidden([stored({ kind: 'single' })], new Set(['album:1']));
  assert.equal(rows.length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with `does not provide an export named 'mergeHidden'`.

- [ ] **Step 3: Write minimal implementation**

Add to `src/trending.ts`:

```ts
export interface TrendingRow extends ChartRow {
  rating_key: string | null;
  guid: string | null;
  mbid: string | null;
  tracked: boolean;
  in_library: boolean;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS trending_items (
  kind         TEXT NOT NULL,
  id           TEXT NOT NULL,
  rank         INTEGER NOT NULL,
  title        TEXT NOT NULL,
  subtitle     TEXT NOT NULL DEFAULT '',
  release_date TEXT,
  thumb        TEXT,
  link         TEXT,
  rating_key   TEXT,
  guid         TEXT,
  mbid         TEXT,
  built_at     TEXT NOT NULL,
  PRIMARY KEY (kind, id)
);
CREATE TABLE IF NOT EXISTS trending_hidden (
  kind      TEXT NOT NULL,
  id        TEXT NOT NULL,
  hidden_at TEXT NOT NULL,
  PRIMARY KEY (kind, id)
);`;
db.exec(SCHEMA);

/**
 * Hiding lives in its own table because trending_items is emptied and rewritten
 * on every build, so a hidden column would be wiped with it.
 */
export function mergeHidden(rows: TrendingRow[], hidden: Set<string>): TrendingRow[] {
  return rows.filter((r) => !hidden.has(`${r.kind}:${r.id}`));
}

export function saveTrending(rows: TrendingRow[]): void {
  const at = nowIso();
  db.exec('DELETE FROM trending_items');
  const insert = db.prepare(
    `INSERT INTO trending_items
       (kind, id, rank, title, subtitle, release_date, thumb, link, rating_key, guid, mbid, built_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of rows) {
    insert.run(
      r.kind, r.id, r.rank, r.title, r.subtitle, r.release_date,
      r.thumb, r.link, r.rating_key, r.guid, r.mbid, at,
    );
  }
}

export function builtAt(): string | null {
  const row = db.prepare('SELECT MAX(built_at) AS at FROM trending_items').get() as {
    at: string | null;
  };
  return row.at;
}

export function hideTrending(kind: string, id: string, hidden: boolean): void {
  if (hidden) {
    db.prepare(
      'INSERT OR REPLACE INTO trending_hidden (kind, id, hidden_at) VALUES (?, ?, ?)',
    ).run(kind, id, nowIso());
  } else {
    db.prepare('DELETE FROM trending_hidden WHERE kind = ? AND id = ?').run(kind, id);
  }
}

export function listTrending(): TrendingRow[] {
  const raw = db
    .prepare('SELECT * FROM trending_items ORDER BY kind, rank')
    .all() as Record<string, unknown>[];

  const held = new Set(
    (db.prepare('SELECT guid FROM library_guids').all() as { guid: string }[]).map((r) => r.guid),
  );
  const watchlisted = new Set(
    (db.prepare("SELECT rating_key FROM watchlist_items WHERE state = 'listed'").all() as {
      rating_key: string;
    }[]).map((r) => r.rating_key),
  );
  const watchedArtists = new Set(
    (db.prepare('SELECT mbid FROM artists WHERE mbid IS NOT NULL AND present = 1').all() as {
      mbid: string;
    }[]).map((r) => r.mbid),
  );
  const hidden = new Set(
    (db.prepare('SELECT kind, id FROM trending_hidden').all() as {
      kind: string;
      id: string;
    }[]).map((r) => `${r.kind}:${r.id}`),
  );

  const rows = raw.map((r) => ({
    kind: r.kind as TrendingKind,
    id: String(r.id),
    rank: Number(r.rank),
    title: String(r.title),
    subtitle: String(r.subtitle ?? ''),
    release_date: (r.release_date as string) ?? null,
    thumb: (r.thumb as string) ?? null,
    link: (r.link as string) ?? null,
    rating_key: (r.rating_key as string) ?? null,
    guid: (r.guid as string) ?? null,
    mbid: (r.mbid as string) ?? null,
    tracked:
      r.mbid !== null
        ? watchedArtists.has(r.mbid as string)
        : watchlisted.has(String(r.rating_key ?? '')),
    in_library: held.has(String(r.guid ?? '')),
  }));
  return mergeHidden(rows, hidden);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` then `npm run typecheck`
Expected: PASS and silent.

- [ ] **Step 5: Commit**

```bash
git add src/trending.ts tests/trending.test.ts
git commit -m "feat(trending): store the built chart and remember hidden rows"
```

---

### Task 7: Build the chart end to end

**Files:**
- Modify: `src/trending.ts`

**Interfaces:**
- Consumes: everything from Tasks 1 to 6.
- Produces: `buildTrending(onProgress?: (m: string) => void): Promise<{ count: number; message: string }>`.

There is no test in this task. It is orchestration over functions already covered, and exercising it means calling four live services.

- [ ] **Step 1: Write the build**

Add to `src/trending.ts`:

```ts
import * as store from './db.ts';
import { trendingFromTmdb } from './tmdb.ts';
import { findDiscoverMatch } from './search.ts';

export async function buildTrending(
  onProgress?: (m: string) => void,
): Promise<{ count: number; message: string }> {
  const key = store.getSetting('tmdb_api_key').trim();
  const token = store.getSetting('plex_token');
  const notes: string[] = [];
  const rows: TrendingRow[] = [];

  // Films and shows. Without a TMDB key these two lists are simply absent, and
  // the tab says so rather than showing an empty chip.
  if (key) {
    for (const kind of ['movie', 'show'] as const) {
      onProgress?.(`Trending ${kind === 'movie' ? 'films' : 'shows'}`);
      try {
        const chart = await trendingFromTmdb(kind, key);
        for (let i = 0; i < chart.length; i += 1) {
          const row = chart[i]!;
          onProgress?.(`Matching ${kind} ${i + 1} of ${chart.length}: ${row.title}`);
          const year = row.release_date ? Number(row.release_date.slice(0, 4)) : null;
          const match = token ? await findDiscoverMatch(row.title, year, token) : null;
          rows.push({
            ...row,
            rating_key: match?.ratingKey ?? null,
            guid: match?.guid ?? null,
            mbid: null,
            tracked: false,
            in_library: false,
          });
        }
      } catch (err) {
        notes.push(`${kind}: ${(err as Error).message}`);
      }
    }
  } else {
    notes.push('no TMDB key, so films and shows were skipped');
  }

  // Country music. No key needed.
  for (const kind of ['album', 'single'] as const) {
    onProgress?.(`Trending country ${kind}s`);
    try {
      const chart = await trendingFromApple(kind);
      for (let i = 0; i < chart.length; i += 1) {
        const row = chart[i]!;
        onProgress?.(`Matching artist ${i + 1} of ${chart.length}: ${row.subtitle}`);
        rows.push({
          ...row,
          rating_key: null,
          guid: null,
          mbid: await resolveArtist(row.subtitle),
          tracked: false,
          in_library: false,
        });
      }
    } catch (err) {
      notes.push(`country ${kind}s: ${(err as Error).message}`);
    }
  }

  saveTrending(rows);
  return {
    count: rows.length,
    message: notes.length
      ? `${rows.length} trending items, with problems (${notes.join('; ')}).`
      : `${rows.length} trending items.`,
  };
}
```

- [ ] **Step 2: Run the suite and typecheck**

Run: `npm test` then `npm run typecheck`
Expected: PASS and silent.

- [ ] **Step 3: Commit**

```bash
git add src/trending.ts
git commit -m "feat(trending): build all four charts with progress"
```

---

### Task 8: Proxy chart artwork safely

**Files:**
- Modify: `src/api.ts` (the `proxyThumb` function and the `/thumb` route)
- Test: `tests/api.test.ts` (create)

**Interfaces:**
- Produces: `allowedThumbHost(url: string): boolean` exported from `src/api.ts`, and a `url` parameter on `/thumb`.

- [ ] **Step 1: Write the failing test**

Create `tests/api.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedThumbHost } from '../src/api.ts';

test('Apple artwork is allowed', () => {
  assert.equal(allowedThumbHost('https://is1-ssl.mzstatic.com/image/a.png'), true);
  assert.equal(allowedThumbHost('https://is5-ssl.mzstatic.com/image/a.png'), true);
});

test('TMDB posters are allowed', () => {
  assert.equal(allowedThumbHost('https://image.tmdb.org/t/p/w342/a.jpg'), true);
});

test('anything else is refused, because an open proxy is a way into the network', () => {
  assert.equal(allowedThumbHost('http://127.0.0.1:32400/library/metadata/1'), false);
  assert.equal(allowedThumbHost('https://example.com/a.png'), false);
  assert.equal(allowedThumbHost('file:///c:/windows/win.ini'), false);
});

test('a host that merely ends with an allowed name is refused', () => {
  assert.equal(allowedThumbHost('https://image.tmdb.org.evil.test/a.jpg'), false);
});

test('nonsense is refused rather than throwing', () => {
  assert.equal(allowedThumbHost('not a url'), false);
  assert.equal(allowedThumbHost(''), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with `does not provide an export named 'allowedThumbHost'`.

- [ ] **Step 3: Write minimal implementation**

Add to `src/api.ts`:

```ts
/**
 * Chart artwork carries no token, so it needs no proxying to keep a secret. It
 * is proxied anyway so the page never talks to third parties, and the host list
 * is what stops that proxy being a way to reach anything on this network.
 */
const THUMB_HOSTS = /^(is[1-5]-ssl\.mzstatic\.com|image\.tmdb\.org)$/;

export function allowedThumbHost(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && THUMB_HOSTS.test(parsed.hostname);
  } catch {
    return false;
  }
}
```

Then add the `url` branch to `proxyThumb`, ahead of the existing `searchThumb` branch, and pass `url.searchParams.get('url')` through from the `/thumb` route:

```ts
  if (directUrl) {
    target = allowedThumbHost(directUrl) ? directUrl : null;
  } else if (searchThumb) {
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` then `npm run typecheck`
Expected: PASS and silent.

- [ ] **Step 5: Commit**

```bash
git add src/api.ts tests/api.test.ts
git commit -m "feat(trending): proxy chart artwork through an allowlist"
```

---

### Task 9: The API routes

**Files:**
- Modify: `src/api.ts`

**Interfaces:**
- Consumes: `listTrending`, `buildTrending`, `hideTrending`, `builtAt` from `src/trending.ts`.
- Produces: `GET /api/trending`, `POST /api/trending/build`, `GET /api/trending/progress`, `POST /api/trending/hide`.

There is no test in this task. The routes are thin wrappers, matching how the suggestions routes are handled.

- [ ] **Step 1: Add the routes**

Add to `src/api.ts`, alongside the suggestions routes:

```ts
    /* ---------------------------------------------------------- trending */
    if (path === '/api/trending' && req.method === 'GET') {
      send(res, 200, {
        items: listTrending(),
        built_at: builtAt(),
        has_tmdb_key: store.getSetting('tmdb_api_key').trim() !== '',
      });
      return true;
    }

    if (path === '/api/trending/build' && req.method === 'POST') {
      if (trendingRunning) return bad(res, 'Trending is already being built.');
      trendingRunning = true;
      trendingProgress = 'Starting';
      void buildTrending((m) => {
        trendingProgress = m;
      })
        .then((r) => {
          trendingProgress = r.message;
        })
        .catch((e: Error) => {
          trendingProgress = `Failed: ${e.message}`;
        })
        .finally(() => {
          trendingRunning = false;
        });
      send(res, 202, { started: true });
      return true;
    }

    if (path === '/api/trending/progress' && req.method === 'GET') {
      send(res, 200, { running: trendingRunning, message: trendingProgress });
      return true;
    }

    if (path === '/api/trending/hide' && req.method === 'POST') {
      const body = await readJson(req);
      const kind = String(body.kind ?? '');
      const id = String(body.id ?? '');
      if (!kind || !id) return bad(res, 'kind and id are required');
      hideTrending(kind, id, body.hidden !== false);
      send(res, 200, { ok: true });
      return true;
    }
```

And beside the existing `suggestionsRunning` pair:

```ts
let trendingRunning = false;
let trendingProgress = '';
```

- [ ] **Step 2: Verify by hand**

Run `npm start`, then:

```bash
curl -s -X POST http://127.0.0.1:7000/api/trending/build
curl -s http://127.0.0.1:7000/api/trending/progress
```

Expected: the build starts, and progress reports each chart in turn.

- [ ] **Step 3: Run the suite and typecheck**

Run: `npm test` then `npm run typecheck`
Expected: PASS and silent.

- [ ] **Step 4: Commit**

```bash
git add src/api.ts
git commit -m "feat(trending): add the trending endpoints"
```

---

### Task 10: The Trending tab

**Files:**
- Modify: `public/index.html`, `public/app.js`, `public/styles.css`

**Interfaces:**
- Consumes: `filterCatalogue` from Task 2, the `/api/trending` routes from Task 9, and the existing `togglePlayer`, `post` and `banner` helpers in `public/app.js`.

There is no test in this task. It is DOM rendering, which this codebase deliberately keeps out of the test suite by putting the logic in `public/feed.js`.

- [ ] **Step 1: Add the tab and panel**

In `public/index.html`, add a tab button after Suggestions:

```html
      <button class="tab" data-tab="trending" role="tab">Trending</button>
```

And a panel, modelled on the suggestions panel:

```html
      <!-- Trending ------------------------------------------------------ -->
      <section id="panel-trending" class="panel" hidden>
        <div class="panel-head">
          <p class="muted">
            What is popular right now. Films and shows from TMDB, country music from the US
            Apple chart.
          </p>
          <button type="button" class="btn" id="trending-btn">Build trending</button>
        </div>
        <div class="filters">
          <input
            type="search"
            id="tr-filter"
            class="input search"
            placeholder="Search trending"
            autocomplete="off"
          />
          <div class="chips" id="tr-chips" role="group" aria-label="Type">
            <button type="button" class="chip is-on" data-tr="movie">Films</button>
            <button type="button" class="chip is-on" data-tr="show">Shows</button>
            <button type="button" class="chip is-on" data-tr="album">Albums</button>
            <button type="button" class="chip" data-tr="single">Singles</button>
          </div>
          <label class="check">
            <input type="checkbox" id="tr-catalogue" /> Catalogue
          </label>
        </div>
        <div class="filter-summary"><span id="tr-summary"></span></div>
        <div id="tr-list" class="cards"></div>
      </section>
```

- [ ] **Step 2: Add the state and rendering**

In `public/app.js`, add `filterCatalogue` to the `./feed.js` import, add to `state`:

```js
  trending: [],
  trendingBuiltAt: null,
  trendingHasKey: true,
  trFilters: { q: '', kinds: new Set(['movie', 'show', 'album']), catalogue: false },
```

Add `if (name === 'trending') loadTrending();` beside the suggestions line in `showTab`, then:

```js
/* -------------------------------------------------------------- trending */

async function loadTrending() {
  try {
    const r = await api('/api/trending');
    state.trending = r.items;
    state.trendingBuiltAt = r.built_at;
    state.trendingHasKey = r.has_tmdb_key;
    renderTrending();
  } catch (err) {
    banner(err.message);
  }
}

function renderTrending() {
  const f = state.trFilters;
  const q = fold(f.q).trim();
  const rows = filterCatalogue(
    state.trending
      .filter((t) => f.kinds.has(t.kind))
      .filter((t) => !q || fold(t.title).includes(q) || fold(t.subtitle).includes(q)),
    f.catalogue,
  );

  $('#tr-summary').textContent = state.trending.length
    ? `${rows.length} of ${plural(state.trending.length, 'item')}` +
      (state.trendingBuiltAt ? `, built ${relativeDays(state.trendingBuiltAt.slice(0, 10))}` : '')
    : '';

  const list = $('#tr-list');
  list.replaceChildren();

  if (rows.length === 0) {
    list.append(
      el(
        'div',
        { class: 'empty' },
        el('strong', {}, state.trending.length ? 'Nothing matches' : 'Nothing built yet'),
        state.trending.length
          ? 'Try a different search, or tick Catalogue to include older records.'
          : state.trendingHasKey
            ? 'Press Build trending. It takes a minute or so the first time.'
            : 'Press Build trending for country music. Films and shows need a free TMDB key in Settings.',
      ),
    );
    return;
  }
  for (const t of rows) list.append(trendingCard(t));
}

const TR_TAG = { movie: 'film', show: 'show', album: 'album', single: 'single' };

function trendingCard(t) {
  const card = el('article', { class: 'card' });
  const art = t.thumb
    ? artwork(`/thumb?url=${encodeURIComponent(t.thumb)}`, t.title)
    : el('div', { class: 'art art-fallback' }, (t.title || '?').charAt(0).toUpperCase());

  card.append(
    art,
    el(
      'div',
      {},
      el('p', { class: 'card-title' }, el('span', { class: 'muted' }, `${t.rank}. `), t.title),
      el('p', { class: 'card-artist' }, t.subtitle || ''),
      el(
        'div',
        { class: 'card-meta' },
        el('span', { class: 'tag' }, TR_TAG[t.kind] ?? t.kind),
        t.release_date ? el('span', {}, formatDate(t.release_date)) : null,
        t.in_library ? el('span', { class: 'tag held' }, '✓ In Plex') : null,
      ),
    ),
    el(
      'div',
      { class: 'card-actions' },
      el(
        'button',
        {
          class: 'btn btn-tiny',
          onclick: () =>
            togglePlayer(
              {
                kind: t.kind === 'album' || t.kind === 'single' ? 'single' : t.kind,
                title: t.title,
                subtitle: t.subtitle,
              },
              card,
            ),
        },
        t.kind === 'movie' || t.kind === 'show' ? 'Trailer' : 'Play',
      ),
      t.link
        ? el('a', { class: 'link', href: t.link, target: '_blank', rel: 'noreferrer' }, 'Details')
        : null,
      trendingAction(t),
      el(
        'button',
        {
          class: 'btn btn-tiny',
          onclick: async (e) => {
            e.currentTarget.disabled = true;
            await post('/api/trending/hide', { kind: t.kind, id: t.id, hidden: true });
            loadTrending();
          },
        },
        'Not for me',
      ),
    ),
  );
  return card;
}

/**
 * A film or show goes onto the real Plex watchlist. Music has no Plex
 * equivalent, so the action is to watch the artist, as Suggestions does.
 */
function trendingAction(t) {
  const isVideo = t.kind === 'movie' || t.kind === 'show';
  if (t.tracked) {
    return el('span', { class: 'tag held' }, isVideo ? '✓ On watchlist' : '✓ Watched');
  }
  if (isVideo && !t.rating_key) return null;
  if (!isVideo && !t.mbid) return null;

  const label = isVideo ? 'Add to watchlist' : 'Watch artist';
  return el(
    'button',
    {
      class: 'btn btn-tiny btn-primary',
      onclick: async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = 'Adding…';
        try {
          const r = await post('/api/search/add', {
            kind: isVideo ? t.kind : 'artist',
            id: isVideo ? t.rating_key : t.mbid,
            title: isVideo ? t.title : t.subtitle,
          });
          banner(r.message, 'ok');
          t.tracked = true;
          renderTrending();
          refreshState();
        } catch (err) {
          banner(err.message);
          btn.disabled = false;
          btn.textContent = label;
        }
      },
    },
    label,
  );
}

$('#tr-filter').addEventListener('input', (e) => {
  state.trFilters.q = e.target.value;
  renderTrending();
});

$('#tr-catalogue').addEventListener('change', (e) => {
  state.trFilters.catalogue = e.target.checked;
  renderTrending();
});

$$('#tr-chips .chip').forEach((chip) =>
  chip.addEventListener('click', () => {
    const k = chip.dataset.tr;
    const set = state.trFilters.kinds;
    if (set.has(k)) set.delete(k);
    else set.add(k);
    chip.classList.toggle('is-on', set.has(k));
    renderTrending();
  }),
);

$('#trending-btn').addEventListener('click', async (e) => {
  e.currentTarget.disabled = true;
  try {
    await post('/api/trending/build', {});
    pollTrending();
  } catch (err) {
    banner(err.message);
    e.currentTarget.disabled = false;
  }
});

async function pollTrending() {
  try {
    const { running, message } = await api('/api/trending/progress');
    $('#trending-btn').disabled = running;
    $('#trending-btn').textContent = running ? 'Building…' : 'Build trending';
    $('#tr-summary').textContent = message || '';
    if (running) setTimeout(pollTrending, 1500);
    else loadTrending();
  } catch {
    $('#trending-btn').disabled = false;
  }
}
```

- [ ] **Step 3: Check it in the browser**

Run `npm start`, open <http://localhost:7000>, press Trending, then Build trending. Confirm: the chart fills, rank numbers read 1 upwards with gaps where catalogue is hidden, ticking Catalogue fills the gaps, Singles is off until pressed, Trailer and Play open a player, and Add to watchlist turns into a tick.

- [ ] **Step 4: Run the suite and typecheck**

Run: `npm test` then `npm run typecheck`
Expected: PASS and silent.

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/app.js public/styles.css
git commit -m "feat(trending): add the Trending tab"
```

---

### Task 11: Document it

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a Trending section**

After the description of the Suggestions tab in "The tabs", add:

```markdown
**Trending** is what is popular right now, rather than what is coming for the
things you already follow. Films and shows come from TMDB weekly trending and
need the same free key as film dates. Country music comes from the US Apple
chart and needs no key at all. Albums are shown by default; press Singles for
the singles chart.

Records older than a year are hidden behind the **Catalogue** tickbox, because
about thirty of the top fifty country albums in any week are catalogue. The
chart position is kept on every row, so hiding catalogue leaves gaps in the
numbering rather than pretending the chart is shorter than it is.
```

Add `src/trending.ts` to the developer file table:

```markdown
| `src/trending.ts` | The TMDB and Apple charts, and what they resolve to |
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: describe the Trending tab"
```

---

## Self-review

**Spec coverage.** Sources table, Task 5. TMDB paging and trimming to 50, Task 5. No key means no films or shows, Tasks 7 and 10. Film and show resolution to a rating key, Task 3. Artist resolution with the fortnight cache and the rate limit, Task 4. An unresolved artist keeping its play button and losing only the Watch artist button, Task 10 in `trendingAction`. The catalogue rule including the null date case, Task 2. Rank kept and shown, Tasks 1, 6 and 10. Already-have ticks, Task 6 in `listTrending`. Trailers reusing `/api/youtube`, Task 10. Artwork allowlist, Task 8. Freshness, built-at and the manual build, Tasks 6, 9 and 10. Storage tables, Task 6. Every test named in the spec's testing section appears in Tasks 1 to 4, 6 and 8.

**One gap found and closed.** The spec says the stored list is considered fresh for twenty-four hours and that a list older than a day is shown with a note saying when it was built. Task 10 renders `built_at` through `relativeDays` in the summary line, which covers it. There is no automatic rebuild, deliberately, since the spec makes building manual.

**Placeholders.** None. Every code step carries the code.

**Type consistency.** `ChartRow` is defined in Task 1 and extended by `TrendingRow` in Task 6. `trendingFromTmdb` in Task 5 returns `ChartRow[]` and is consumed as such in Task 7. `findDiscoverMatch` returns `{ratingKey, guid}` in Task 3 and is destructured with those names in Task 7. `pickArtistMatch` and `resolveArtist` in Task 4 match their use in Task 7. The `kind` values `movie`, `show`, `album` and `single` are used identically in the schema, the chips and `TR_TAG`.

**One circular import to watch.** Task 5 has `src/tmdb.ts` importing `ChartRow` from `src/trending.ts`, while Task 7 has `src/trending.ts` importing `trendingFromTmdb` from `src/tmdb.ts`. It is a type-only import in one direction, which Node's type stripping erases, so it does not become a runtime cycle. If it causes trouble, move `ChartRow` into its own module rather than working around it.
