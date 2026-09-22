/**
 * Resolves a search phrase to a YouTube video id so the dashboard can embed a
 * player inline.
 *
 * There is no API key involved. This reads the public search results page,
 * pulls out the candidates with their titles, and only accepts one whose title
 * actually matches what was asked for. Returning nothing is better than
 * returning a popular song by the right artist that is not the track listed,
 * so an unverified guess is never used. Every caller also gets a plain search
 * link that always works.
 */
import { db } from './db.ts';
import { nowIso } from './dates.ts';

// Lightweight migration: older databases have no video_title column.
try {
  db.exec('ALTER TABLE youtube_cache ADD COLUMN video_title TEXT');
} catch {
  // Already there.
}

const SEARCH = 'https://www.youtube.com/results?search_query=';
// sp=EgIQAQ%3D%3D restricts results to videos, keeping channels and playlists out.
const VIDEO_ONLY = '&sp=EgIQAQ%3D%3D';

/** Cached for a fortnight: results barely move and lookups are the slow part. */
const CACHE_DAYS = 14;

export interface YoutubeResult {
  query: string;
  video_id: string | null;
  video_title: string | null;
  search_url: string;
  embed_url: string | null;
}

export function searchUrl(query: string): string {
  return `${SEARCH}${encodeURIComponent(query)}`;
}

/* ---------------------------------------------------------------- matching */

function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export interface Candidate {
  id: string;
  title: string;
  channel: string;
}

/**
 * What the result has to look like to be accepted. Music needs both the track
 * title and the artist; a trailer needs the film title and the word trailer.
 */
export interface Expectation {
  kind: string;
  title: string;
  artist: string;
}

export function scoreCandidate(c: Candidate, want: Expectation): number {
  const videoTitle = fold(c.title);
  const channel = fold(c.channel);
  const wantTitle = fold(want.title);
  const wantArtist = fold(want.artist);
  if (!wantTitle) return 0;

  const titleHit = videoTitle.includes(wantTitle);
  if (!titleHit) return 0;

  let score = 10;

  if (want.kind === 'movie' || want.kind === 'show') {
    // A trailer, teaser or clip is what was asked for, not a full upload.
    if (/\b(trailer|teaser)\b/.test(videoTitle)) score += 6;
    else score -= 4;
    if (/\b(official)\b/.test(videoTitle)) score += 2;
  } else {
    const artistHit =
      wantArtist !== '' && (videoTitle.includes(wantArtist) || channel.includes(wantArtist));
    // An auto-generated art track is titled with the bare song name and sits on
    // a "- Topic" channel, which YouTube sometimes names after the label rather
    // than the artist. An exact title match is strong enough to accept on its
    // own, but scores below a result that also names the artist.
    const exactTitle = videoTitle === wantTitle;
    if (!artistHit && !exactTitle) return 0;
    score += artistHit ? 6 : 2;
    if (/\btopic\b/.test(channel)) score += 2;
    if (/\b(official|audio|lyric|video)\b/.test(videoTitle)) score += 2;
    if (/\b(live|cover|reaction|remix|karaoke|instrumental|tribute)\b/.test(videoTitle)) {
      score -= 6;
    }
  }

  // A title that is barely longer than what was asked for is a closer match
  // than one padded with a dozen other words.
  score -= Math.min(4, Math.floor(Math.abs(videoTitle.length - wantTitle.length) / 25));
  return score;
}

/* ------------------------------------------------------------- extraction */

/** Pulls every video result, with its title, out of the search page. */
export function extractCandidates(html: string): Candidate[] {
  const start = html.indexOf('ytInitialData');
  if (start === -1) return [];
  const braceStart = html.indexOf('{', start);
  if (braceStart === -1) return [];

  // Walk the braces to find where the JSON blob ends, since it contains plenty
  // of nested objects and a lazy regex would cut it short.
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let i = braceStart; i < html.length; i += 1) {
    const ch = html[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
    if (i - braceStart > 5_000_000) break; // sanity cap
  }
  if (end === -1) return [];

  let data: unknown;
  try {
    data = JSON.parse(html.slice(braceStart, end));
  } catch {
    return [];
  }

  const out: Candidate[] = [];
  const seen = new Set<string>();

  const walk = (node: unknown): void => {
    if (out.length >= 25 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    const obj = node as Record<string, unknown>;
    const renderer = obj.videoRenderer as Record<string, unknown> | undefined;
    if (renderer && typeof renderer.videoId === 'string') {
      const id = renderer.videoId;
      if (!seen.has(id)) {
        seen.add(id);
        out.push({
          id,
          title: runsText(renderer.title),
          channel: runsText(renderer.ownerText) || runsText(renderer.longBylineText),
        });
      }
    }
    for (const value of Object.values(obj)) walk(value);
  };
  walk(data);
  return out;
}

function runsText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const obj = node as { runs?: { text?: string }[]; simpleText?: string };
  if (typeof obj.simpleText === 'string') return obj.simpleText;
  return (obj.runs ?? []).map((r) => r.text ?? '').join('');
}

/* -------------------------------------------------------------- resolution */

interface CacheRow {
  video_id: string | null;
  video_title: string | null;
  looked_up: string;
}

function cached(query: string): CacheRow | undefined {
  return db
    .prepare('SELECT video_id, video_title, looked_up FROM youtube_cache WHERE query = ?')
    .get(query) as CacheRow | undefined;
}

function remember(query: string, videoId: string | null, videoTitle: string | null): void {
  db.prepare(
    `INSERT INTO youtube_cache (query, video_id, video_title, looked_up) VALUES (?, ?, ?, ?)
     ON CONFLICT(query) DO UPDATE SET
       video_id = excluded.video_id,
       video_title = excluded.video_title,
       looked_up = excluded.looked_up`,
  ).run(query, videoId, videoTitle, nowIso());
}

const isFresh = (lookedUp: string): boolean =>
  Date.now() - Date.parse(lookedUp) < CACHE_DAYS * 86_400_000;

/**
 * What `lookup` actually managed to do. `ok: false` means YouTube was not
 * successfully asked at all (the fetch threw, timed out, or came back
 * non-ok); `ok: true` with `candidate: null` means YouTube answered and
 * nothing in the results matched. Only the second is a real answer worth
 * caching for a fortnight. Pulled out as a plain object, rather than folded
 * straight into `resolve`, so the caching rule below can be tested without a
 * network call.
 */
export type LookupOutcome = { ok: true; candidate: Candidate | null } | { ok: false };

/**
 * Decides what `resolve` should store and return for a given lookup outcome.
 * Matching `resolveArtist` in trending.ts: a real answer, matched or not, is
 * worth the fortnight of caching; a failed attempt is not an answer at all,
 * so caching it would misrepresent a network blip as "no such video" and
 * hide the play button for a fortnight. Leaving the row alone means the next
 * request simply asks again.
 */
export function applyLookupOutcome(
  outcome: LookupOutcome,
): { video_id: string | null; video_title: string | null; shouldCache: boolean } {
  if (!outcome.ok) return { video_id: null, video_title: null, shouldCache: false };
  return {
    video_id: outcome.candidate?.id ?? null,
    video_title: outcome.candidate?.title ?? null,
    shouldCache: true,
  };
}

export async function resolve(want: Expectation): Promise<YoutubeResult> {
  const query = queryFor(want);
  const result: YoutubeResult = {
    query,
    video_id: null,
    video_title: null,
    search_url: searchUrl(query),
    embed_url: null,
  };
  if (!want.title.trim()) return result;

  const hit = cached(query);
  if (hit && isFresh(hit.looked_up)) {
    result.video_id = hit.video_id;
    result.video_title = hit.video_title;
  } else {
    const outcome = await lookup(query, want);
    const decided = applyLookupOutcome(outcome);
    result.video_id = decided.video_id;
    result.video_title = decided.video_title;
    if (decided.shouldCache) remember(query, result.video_id, result.video_title);
  }

  if (result.video_id) {
    result.embed_url = `https://www.youtube-nocookie.com/embed/${result.video_id}?rel=0`;
  }
  return result;
}

async function lookup(query: string, want: Expectation): Promise<LookupOutcome> {
  try {
    const res = await fetch(`${searchUrl(query)}${VIDEO_ONLY}`, {
      headers: {
        // Without a browser-shaped request YouTube serves a consent wall.
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
        'Accept-Language': 'en-AU,en;q=0.9',
      },
      signal: AbortSignal.timeout(15_000),
    });
    // A non-ok response means YouTube was not actually asked in any useful
    // sense, so this is a failed attempt, not an answer of "nothing found".
    if (!res.ok) return { ok: false };

    const candidates = extractCandidates(await res.text());
    let best: { c: Candidate; score: number } | null = null;
    for (const c of candidates) {
      const score = scoreCandidate(c, want);
      if (score > 0 && (!best || score > best.score)) best = { c, score };
    }
    return { ok: true, candidate: best ? best.c : null };
  } catch {
    // The fetch itself threw (network blip, timeout, DNS). Same reasoning:
    // this is not YouTube saying no, so it must not be reported as one.
    return { ok: false };
  }
}

/**
 * The phrase most likely to find the right thing. Bracketed parts of a track
 * name are kept, because "(Again)" is what separates one song from another.
 */
export function queryFor(want: Expectation): string {
  const title = want.title.trim();
  switch (want.kind) {
    case 'movie':
      return `${title} official trailer`;
    case 'show':
      return `${title} trailer`;
    default:
      return `${want.artist} ${title}`.trim();
  }
}

/** Drops every cached answer, for when the matching rules change. */
export function clearCache(): number {
  const before = (db.prepare('SELECT COUNT(*) AS n FROM youtube_cache').get() as { n: number }).n;
  db.exec('DELETE FROM youtube_cache');
  return before;
}
