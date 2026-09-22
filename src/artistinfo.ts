/**
 * A picture and a line of description for an artist, for the Suggestions tab.
 *
 * ListenBrainz names a similar artist and nothing else, so both have to be
 * found elsewhere. One MusicBrainz artist lookup carries everything needed:
 * the type, place and life span that make up the description, the tags that
 * give it a genre, and the Wikidata link. Wikidata then answers with the P18
 * image claim, which is a Commons file name rather than a URL, so the URL is
 * built from it by hand. That is two network calls per artist and no third,
 * because Special:FilePath redirects to the real file and the thumbnail proxy
 * already follows redirects with the allowlist applied at every hop.
 *
 * Answers are cached for a month. Neither where an artist is from nor what
 * they look like changes often, and a suggestion list overlaps heavily with
 * the one before it, so a rebuild mostly reads this table rather than the
 * network.
 */
import { db } from './db.ts';
import { nowIso } from './dates.ts';
import { lookupArtistDetail } from './musicbrainz.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS artist_info_cache (
  mbid      TEXT PRIMARY KEY,
  blurb     TEXT NOT NULL DEFAULT '',
  thumb     TEXT,
  looked_up TEXT NOT NULL
);`;
db.exec(SCHEMA);

/** Matching the detail cache, for the same reason: answers barely move. */
const CACHE_DAYS = 30;

const COMMONS = 'https://commons.wikimedia.org/wiki/Special:FilePath/';
const ENTITY_DATA = 'https://www.wikidata.org/wiki/Special:EntityData/';

/** Wide enough for the 76px card tile on a high density screen, and no wider. */
const IMAGE_WIDTH = 300;

export interface MbArtistDetail {
  id: string;
  name: string;
  type?: string | null;
  disambiguation?: string;
  country?: string | null;
  area?: { name?: string } | null;
  'begin-area'?: { name?: string } | null;
  'life-span'?: { begin?: string | null; end?: string | null; ended?: boolean } | null;
  tags?: { name?: string; count?: number }[];
  relations?: { type?: string; url?: { resource?: string } }[];
}

export interface ArtistInfo {
  blurb: string;
  thumb: string | null;
}

/* ------------------------------------------------------------------ blurb */

/** How many tags read as a description rather than a list. */
const MAX_TAGS = 3;

/**
 * MusicBrainz types are catalogue labels, not English. "Person from Ireland"
 * reads as a census entry, so Person becomes artist and Group stays a group.
 * Anything rarer is used as it stands, lowercased, since Orchestra and Choir
 * already read correctly in the sentence.
 */
function nounFor(type: string | null | undefined): string | null {
  if (!type || type === 'Other') return null;
  if (type === 'Person') return 'artist';
  return type.toLowerCase();
}

/** Tags ordered by how many people voted for them, strongest first. */
function rankedTags(detail: MbArtistDetail): string[] {
  return (detail.tags ?? [])
    .filter((t): t is { name: string; count?: number } => Boolean(t.name))
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
    .map((t) => t.name);
}

/**
 * Where the act is from, most specific first. The two-letter country code is
 * deliberately ignored: "from US" reads as a mistake, and the area name says
 * the same thing properly whenever MusicBrainz has it.
 */
function placeFor(detail: MbArtistDetail): string | null {
  const town = detail['begin-area']?.name ?? null;
  const area = detail.area?.name ?? null;
  if (town && area && town !== area) return `${town}, ${area}`;
  return town ?? area;
}

/**
 * A life span means different things for different types: a group is formed
 * and disbanded, a person is born and dies. With no type there is no wording
 * that is not a guess, so the dates are left out rather than risk calling a
 * birth a formation.
 */
function spanFor(detail: MbArtistDetail): string | null {
  const span = detail['life-span'];
  const begin = year(span?.begin);
  if (!begin) return null;

  const verbs =
    detail.type === 'Group'
      ? { start: 'formed', end: 'disbanded' }
      : detail.type === 'Person'
        ? { start: 'born', end: 'died' }
        : null;
  if (!verbs) return null;

  const end = year(span?.end);
  return end ? `${verbs.start} ${begin}, ${verbs.end} ${end}` : `${verbs.start} ${begin}`;
}

/** MusicBrainz dates can be a year, a year-month or a full date. */
function year(raw: string | null | undefined): string | null {
  const m = raw?.match(/^(\d{4})/);
  return m ? m[1]! : null;
}

/**
 * One or two plain sentences about an artist, built from whatever MusicBrainz
 * actually holds. Every part is optional, and a part that is missing is left
 * out rather than padded, so an artist nobody has catalogued gets no blurb at
 * all instead of a sentence that says nothing.
 */
export function artistBlurb(detail: MbArtistDetail): string {
  const tags = rankedTags(detail);
  const place = placeFor(detail);

  // Untyped artists are common among the smaller acts ListenBrainz turns up,
  // and "from Canada" cannot start a sentence on its own. Artist is the word
  // the rest of the app uses for a band as much as a singer, so it stands in.
  // With nothing else to say, though, there is no lead and no sentence.
  const noun = nounFor(detail.type) ?? (place || tags.length ? 'artist' : null);
  const genre = noun ? tags[0] ?? null : null;

  // "Country group from Nashville" runs on without punctuation, but the life
  // span is a separate thought and takes a comma.
  const who = [noun ? [genre, noun].filter(Boolean).join(' ') : null, prefix('from', place)]
    .filter(Boolean)
    .join(' ');
  const span = spanFor(detail);

  // Only the tags the lead did not already use, so "Country group" is not
  // followed by "Tagged country".
  const rest = tags.filter((t) => t !== genre).slice(0, MAX_TAGS);

  const sentences = [
    [who || null, span].filter(Boolean).join(', ') || null,
    rest.length ? `tagged ${rest.join(', ')}` : null,
  ].filter((s): s is string => Boolean(s));

  return sentences.map((s) => `${s[0]!.toUpperCase()}${s.slice(1)}.`).join(' ');
}

function prefix(word: string, value: string | null): string | null {
  return value ? `${word} ${value}` : null;
}

/* --------------------------------------------------------------- wikidata */

/**
 * The Wikidata entity id behind an artist, taken off the relationship list.
 *
 * The URL is matched whole rather than searched for a Q number, because the
 * id is about to be pasted into a URL of our own. A relation pointing
 * somewhere unexpected is treated as no relation at all.
 */
export function wikidataId(detail: MbArtistDetail): string | null {
  for (const rel of detail.relations ?? []) {
    if (rel.type !== 'wikidata') continue;
    const m = rel.url?.resource?.match(
      /^https?:\/\/(?:www\.)?wikidata\.org\/(?:wiki|entity)\/(Q\d+)$/,
    );
    if (m) return m[1]!;
  }
  return null;
}

/**
 * A Commons file name turned into a URL that serves the file itself.
 *
 * The name arrives from Wikidata, so it is escaped rather than trusted:
 * without that, a name carrying a slash or a question mark would change which
 * URL is requested. Spaces are underscores by Commons convention, and
 * everything else is percent encoded.
 */
export function commonsImageUrl(fileName: string): string | null {
  const trimmed = fileName.trim();
  if (!trimmed) return null;
  return `${COMMONS}${encodeURIComponent(trimmed.replace(/ /g, '_'))}?width=${IMAGE_WIDTH}`;
}

interface EntityData {
  entities?: Record<
    string,
    { claims?: Record<string, { mainsnak?: { datavalue?: { value?: unknown } } }[]> }
  >;
}

/** The P18 picture claim on a Wikidata entity, as a URL. */
export function wikidataImage(raw: unknown, qid: string): string | null {
  const claim = (raw as EntityData)?.entities?.[qid]?.claims?.P18?.[0];
  const value = claim?.mainsnak?.datavalue?.value;
  return typeof value === 'string' ? commonsImageUrl(value) : null;
}

async function fetchWikidataImage(qid: string): Promise<string | null> {
  try {
    const res = await fetch(`${ENTITY_DATA}${qid}.json`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    return wikidataImage(await res.json(), qid);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ cache */

const isFresh = (lookedUp: string): boolean =>
  Date.now() - Date.parse(lookedUp) < CACHE_DAYS * 86_400_000;

function cached(mbid: string): ArtistInfo | null {
  const row = db
    .prepare('SELECT blurb, thumb, looked_up FROM artist_info_cache WHERE mbid = ?')
    .get(mbid) as { blurb: string; thumb: string | null; looked_up: string } | undefined;
  if (!row || !isFresh(row.looked_up)) return null;
  return { blurb: row.blurb, thumb: row.thumb };
}

function remember(mbid: string, info: ArtistInfo): void {
  db.prepare(
    `INSERT INTO artist_info_cache (mbid, blurb, thumb, looked_up) VALUES (?, ?, ?, ?)
     ON CONFLICT(mbid) DO UPDATE SET
       blurb = excluded.blurb, thumb = excluded.thumb, looked_up = excluded.looked_up`,
  ).run(mbid, info.blurb, info.thumb, nowIso());
}

/**
 * The picture and blurb for one artist, from cache when it is there.
 *
 * A failure is cached as an empty answer on purpose. An artist Wikidata has
 * never heard of would otherwise be looked up again on every build, and the
 * MusicBrainz queue that costs a second a call is the slowest part of a
 * suggestions run.
 */
export async function getArtistInfo(mbid: string): Promise<ArtistInfo> {
  const hit = cached(mbid);
  if (hit) return hit;

  let info: ArtistInfo = { blurb: '', thumb: null };
  try {
    const detail = (await lookupArtistDetail(mbid)) as MbArtistDetail;
    const qid = wikidataId(detail);
    info = {
      blurb: artistBlurb(detail),
      thumb: qid ? await fetchWikidataImage(qid) : null,
    };
  } catch {
    // A card with no picture is fine; a build that stops on one dead artist
    // is not.
  }
  remember(mbid, info);
  return info;
}
