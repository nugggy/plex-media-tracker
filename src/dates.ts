/**
 * Release dates are plain calendar dates, so every comparison has to happen in
 * the user's own calendar. Using toISOString() would compare against UTC, which
 * in Sydney is up to eleven hours behind: a record released today would read as
 * upcoming until mid-morning.
 */

export const TIMEZONE = 'Australia/Sydney';

// en-CA formats as YYYY-MM-DD, which is what MusicBrainz and Plex both use.
const DATE_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Today's date in Sydney, as YYYY-MM-DD. */
export function today(): string {
  return DATE_FORMAT.format(new Date());
}

/** The Sydney date this many days before today. */
export function daysAgo(days: number): string {
  return DATE_FORMAT.format(new Date(Date.now() - days * 86_400_000));
}

/** The Sydney date this many days after today. */
export function daysAhead(days: number): string {
  return DATE_FORMAT.format(new Date(Date.now() + days * 86_400_000));
}

/**
 * Timestamps stay in UTC. Only calendar dates are localised, so stored
 * instants remain unambiguous and sortable.
 */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * The Sydney calendar date an instant (a stored `nowIso()` timestamp) falls
 * on. Sydney is ten or eleven hours ahead of UTC, so slicing the first ten
 * characters off the ISO string gives the UTC date instead, which reads as
 * yesterday for the first ten or eleven hours of the Sydney day.
 */
export function sydneyDate(iso: string): string {
  return DATE_FORMAT.format(new Date(iso));
}

/** Whole days from today in Sydney. Negative is in the past. */
export function daysFromToday(date: string): number {
  const [ty, tm, td] = today().split('-').map(Number);
  const [y, m, d] = date.split('-').map(Number);
  const a = Date.UTC(ty!, tm! - 1, td!);
  const b = Date.UTC(y!, m! - 1, d!);
  return Math.round((b - a) / 86_400_000);
}
