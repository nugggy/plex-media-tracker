/**
 * Title and name normalisation. Plex and MusicBrainz rarely spell an album the
 * same way, so both sides get pushed through the same funnel before comparison.
 */

/** Bracketed suffixes that mark the same record rather than a different one. */
const EDITION_NOISE =
  /\b(deluxe|expanded|extended|special|limited|collector'?s?|anniversary|remaster(ed)?|reissue|bonus|explicit|clean|mono|stereo|edition|version|edit|remix(es)?|live at .*|the complete .*|super deluxe)\b/g;

export function normaliseTitle(input: string): string {
  let s = input.toLowerCase();

  // Drop anything in brackets, then anything after a trailing dash qualifier.
  s = s.replace(/[([{][^)\]}]*[)\]}]/g, ' ');
  s = s.replace(/\s[-–—]\s.*$/, ' ');

  s = stripAccents(s);
  s = s.replace(EDITION_NOISE, ' ');
  s = s.replace(/\band\b/g, '&');
  s = s.replace(/[^a-z0-9&]+/g, ' ');
  s = s.replace(/^(the|a|an)\s+/, '');
  return s.trim().replace(/\s+/g, ' ');
}

/**
 * Same funnel as normaliseTitle, but for the ownership check only: a bracket
 * is dropped when everything inside it is edition noise (deluxe, remastered,
 * bonus, ...), and kept, as plain words, when it is not. A live album, a
 * soundtrack, an acoustic session and the like carry information a studio
 * chart entry does not, and folding them onto the studio title is exactly the
 * false "In Plex" tick this function exists to avoid. normaliseTitle itself
 * is left untouched because the rest of the app (db.ts and elsewhere) matches
 * on it for ownership across the Artists tab and the Out now feed, and changing
 * what counts as "the same album" there is a different, much bigger change.
 */
export function normaliseTitleForOwnership(input: string): string {
  let s = input.toLowerCase();

  s = s.replace(/[([{]([^)\]}]*)[)\]}]/g, (_whole, inner: string) => {
    // Strip only the noise words from a scratch copy to decide whether
    // anything distinguishing is left; `inner` itself is kept intact so a
    // mixed bracket (rare, but possible) keeps its non-noise words.
    const remainder = inner.replace(EDITION_NOISE, '').replace(/[^a-z0-9]+/g, '');
    return remainder ? ` ${inner} ` : ' ';
  });
  s = s.replace(/\s[-–—]\s.*$/, ' ');

  s = stripAccents(s);
  s = s.replace(EDITION_NOISE, ' ');
  s = s.replace(/\band\b/g, '&');
  s = s.replace(/[^a-z0-9&]+/g, ' ');
  s = s.replace(/^(the|a|an)\s+/, '');
  return s.trim().replace(/\s+/g, ' ');
}

export function normaliseArtistName(input: string): string {
  let s = stripAccents(input.toLowerCase());
  s = s.replace(/\band\b/g, '&');
  s = s.replace(/[^a-z0-9&]+/g, ' ');
  s = s.replace(/^(the)\s+/, '');
  return s.trim().replace(/\s+/g, ' ');
}

function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** How many normalised titles the two sets share. */
export function titleOverlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (t && b.has(t)) n += 1;
  return n;
}

const MBID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Pulls a MusicBrainz id out of whatever shape of GUID Plex happens to use. */
export function mbidFromGuid(guid: string | undefined | null): string | null {
  if (!guid) return null;
  if (!/mbid|musicbrainz/i.test(guid)) return null;
  const m = guid.match(MBID_RE);
  return m ? m[0].toLowerCase() : null;
}

export function isMbid(value: string): boolean {
  return MBID_RE.test(value.trim()) && value.trim().length === 36;
}
