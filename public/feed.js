/**
 * Pure feed logic: filtering, grouping and formatting, with no DOM involved.
 *
 * Kept apart from app.js so it can be tested in Node. The rendering code
 * imports from here; nothing here knows a page exists.
 */

export const ALL_TYPES = ['album', 'ep', 'single', 'movie', 'show'];

export const TYPE_LABELS = {
  album: 'Albums',
  ep: 'EPs',
  single: 'Singles',
  movie: 'Films',
  show: 'Shows',
};

export const KIND_TAG = {
  album: 'album',
  ep: 'EP',
  single: 'single',
  movie: 'film',
  show: 'show',
};

export const DEFAULT_HORIZON = 7;

/**
 * How wide each feed opens. Coming soon keeps its week, because the future is
 * sparse and a week is what you act on.
 *
 * Out now opens on everything the server sent, which is exactly the
 * recent_days window the Out now badge counts over. The two used to disagree,
 * the badge reporting six months against a list showing one week, which is why
 * the badge never matched the tab.
 */
export const DEFAULT_HORIZONS = { out: 0, upcoming: 7 };

/* Out now opens with anything already on the server hidden: the point of the
   tab is what is still missing. Coming soon has nothing to hide yet, so it
   opens showing everything. */
export const DEFAULT_HELD = { out: false, upcoming: true };

/**
 * How far each feed reaches. A week by default in both directions: anything
 * wider buries this week's releases under six months of backlog.
 */
export const HORIZONS = {
  upcoming: [
    { days: 7, label: 'Next 7 days' },
    { days: 14, label: 'Next 2 weeks' },
    { days: 30, label: 'Next month' },
    { days: 90, label: 'Next 3 months' },
    { days: 180, label: 'Next 6 months' },
    { days: 365, label: 'Next year' },
    { days: 0, label: 'Everything ahead' },
  ],
  out: [
    { days: 7, label: 'Last 7 days' },
    { days: 14, label: 'Last 2 weeks' },
    { days: 30, label: 'Last month' },
    { days: 90, label: 'Last 3 months' },
    { days: 180, label: 'Last 6 months' },
    { days: 0, label: 'Everything so far' },
  ],
};

export const SORTS = {
  'date-desc': { label: 'Newest first', fn: (a, b) => cmp(b.date, a.date) },
  'date-asc': { label: 'Oldest first', fn: (a, b) => cmp(a.date, b.date) },
  soonest: { label: 'Soonest first', fn: (a, b) => cmp(a.date, b.date) },
  title: { label: 'Title A to Z', fn: (a, b) => cmp(a.title, b.title) },
  name: { label: 'Artist or year', fn: (a, b) => cmp(a.subtitle, b.subtitle) },
};

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export const cmp = (a, b) =>
  String(a ?? '').localeCompare(String(b ?? ''), 'en-AU', { sensitivity: 'base' });

/** Lowercase and strip accents so "cafe" finds "Café". */
export const fold = (t) =>
  (t || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function formatDate(iso) {
  if (!iso) return 'date unknown';
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/*
 * Everything below works in Sydney's calendar, not the browser's.
 *
 * A release date is a plain calendar date, and the server already decides what
 * is out and what is upcoming in Sydney (see src/dates.ts). If the page then
 * asked the machine what day it is, the two would disagree whenever the
 * browser's clock is set somewhere else: a record out today would read as
 * "tomorrow" on a laptop still on US time, and "Last 7 days" would cover a
 * different week from the one the server filtered. Pinning the zone here keeps
 * the page saying the same thing as the server, on any machine.
 */
export const TIMEZONE = 'Australia/Sydney';

// en-CA formats as YYYY-MM-DD, matching the dates the server sends.
const SYDNEY_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The Sydney calendar date an instant falls on, as YYYY-MM-DD. */
export function sydneyDate(now = new Date()) {
  return SYDNEY_DATE.format(now);
}

/**
 * Calendar dates as a count of days, through UTC so no zone can shift one.
 * Both dates are midnight UTC, so the difference is always whole days.
 */
function dayNumber(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
}

/** A YYYY-MM-DD date shifted by whole days, still as YYYY-MM-DD. */
function shiftDate(iso, days) {
  const moved = new Date((dayNumber(iso) + days) * 86400000);
  return moved.toISOString().slice(0, 10);
}

/** Whole days from today in Sydney. */
export function relativeDays(iso, now = new Date()) {
  if (!iso) return '';
  const days = dayNumber(iso) - dayNumber(sydneyDate(now));
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  return days > 0 ? `in ${days} days` : `${Math.abs(days)} days ago`;
}

/*
 * Episodes carry a real instant from TVMaze, so they can be shown to the
 * minute. Everything else, a record or a film, has a release date and no
 * meaningful release time, and is shown to the day as before.
 */
const SYDNEY_TIME = new Intl.DateTimeFormat('en-AU', {
  timeZone: TIMEZONE,
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

/** The Sydney clock time an instant falls on, e.g. "10:00 pm". */
export function sydneyTime(stamp) {
  if (!stamp) return '';
  const at = new Date(stamp);
  if (Number.isNaN(at.getTime())) return '';
  return SYDNEY_TIME.format(at).toLowerCase().replace(/ | /g, ' ');
}

/** "23 Sep 2026, 10:00 pm", or just the date when no instant is known. */
export function formatWhen(iso, stamp) {
  if (!iso) return '';
  const time = sydneyTime(stamp);
  return time ? `${formatDate(iso)}, ${time}` : formatDate(iso);
}

/**
 * The same wording as relativeDays, except that an instant still ahead of now
 * is not yet out. A 10pm episode called "today" from midnight is the mistake
 * that had shows out a day early all over again, only smaller.
 */
export function relativeWhen(iso, stamp, now = new Date()) {
  if (!iso) return '';
  if (stamp && dayNumber(iso) === dayNumber(sydneyDate(now))) {
    const at = new Date(stamp);
    if (!Number.isNaN(at.getTime()) && at.getTime() > now.getTime()) return 'later today';
  }
  return relativeDays(iso, now);
}

/** Today in Sydney shifted by n days, as YYYY-MM-DD. */
export function horizonCutoff(days, direction, now = new Date()) {
  return shiftDate(sydneyDate(now), direction === 'out' ? -days : days);
}

export const filtersActive = (f, def, defaultHorizon = DEFAULT_HORIZON, defaultHeld = true) =>
  f.q !== '' ||
  f.types.size !== ALL_TYPES.length ||
  f.sort !== def ||
  (f.horizon !== undefined && f.horizon !== defaultHorizon) ||
  f.cinema === true ||
  f.held !== defaultHeld;

export function applyFilters(rows, f, direction, now = new Date()) {
  const q = fold(f.q).trim();
  // horizon 0 means no limit, so the cutoff only applies when one is set.
  const cutoff = f.horizon ? horizonCutoff(f.horizon, direction, now) : null;
  return rows
    .filter((r) => {
      if (!cutoff || !r.date) return true;
      return direction === 'out' ? r.date >= cutoff : r.date <= cutoff;
    })
    // A cinema-only film cannot be watched at home yet, so it stays hidden
    // unless the Cinema box is ticked.
    .filter((r) => f.cinema || r.date_kind !== 'cinema')
    // Things already on the server are shown with a tick by default, and can
    // be hidden entirely by unticking "In library".
    .filter((r) => f.held !== false || r.in_library !== 1)
    .filter((r) => f.types.has(r.kind))
    .filter((r) => !q || fold(r.title).includes(q) || fold(r.subtitle).includes(q))
    .sort(SORTS[f.sort].fn);
}

const episodeCode = (e) => e.subtitle.split(' · ')[0];

export function groupSubtitle(eps, direction) {
  if (direction === 'out') {
    const first = episodeCode(eps[0]);
    const last = episodeCode(eps[eps.length - 1]);
    return first === last ? first : `${first} to ${last}`;
  }
  const next = eps[0];
  return `next ${episodeCode(next)} · ${formatDate(next.date)}`;
}

/**
 * Episode events worth badging a row with. Anything else is just an episode,
 * and saying so on every row would be noise.
 */
export const NOTABLE_EVENTS = [
  'series premiere',
  'season premiere',
  'season finale',
  'series finale',
];

/**
 * A binge drop puts six episodes of one show on one day, which buries
 * everything else. Episodes of the same series collapse into a single row that
 * opens to show them all; a lone episode stays an ordinary row.
 */
export function groupEpisodes(rows, direction) {
  const groups = new Map();
  const out = [];

  for (const r of rows) {
    if (r.source !== 'episode' || !r.group) {
      out.push(r);
      continue;
    }
    const existing = groups.get(r.group);
    if (existing) existing.push(r);
    else groups.set(r.group, [r]);
  }

  for (const eps of groups.values()) {
    if (eps.length === 1) {
      out.push(eps[0]);
      continue;
    }
    const sorted = [...eps].sort((a, b) => cmp(a.date, b.date));
    // Out now leads with the newest episode, Coming soon with the next one.
    const lead = direction === 'out' ? sorted[sorted.length - 1] : sorted[0];
    const held = sorted.filter((e) => e.in_library === 1).length;
    out.push({
      ...lead,
      isGroup: true,
      episodes: sorted,
      subtitle: groupSubtitle(sorted, direction),
      event: `${sorted.length} episodes`,
      // No premiere or finale badge on the group header. The header names one
      // episode, or a range, and a badge sitting beside it reads as a claim
      // about that episode. A run of two where the second is the finale would
      // badge the first as the finale. Each episode carries its own badge in
      // the list the row opens to.
      // A run only counts as held when every episode of it is on the server.
      in_library: held === sorted.length ? 1 : 0,
      heldCount: held,
    });
  }
  return out;
}

/**
 * Suggestions default to this year onwards. TMDB recommendations lean heavily
 * on catalogue, so without this the tab is mostly films from decades ago.
 *
 * A suggestion with no year is kept rather than hidden. Artists never carry
 * one, and hiding something new because its date is missing is the worse of
 * the two errors.
 */
export function filterSuggestionYears(rows, includePrevious, now = new Date()) {
  if (includePrevious) return rows;
  const thisYear = Number(sydneyDate(now).slice(0, 4));
  return rows.filter((s) => s.year == null || s.year >= thisYear);
}

const DAYS = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday',
  'Thursday', 'Friday', 'Saturday',
];

/**
 * The heading above a day's cards. The weekday leads, because when you are
 * looking down a week that is what you scan for, and the year is added only
 * when it is not the current one, since repeating it on every row is noise.
 */
export function dayHeading(iso, now = new Date()) {
  if (!iso) return 'Date unknown';
  const [y, m, d] = iso.split('-').map(Number);
  const weekday = DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const stem = `${weekday} ${d} ${MONTHS[m - 1]}`;
  return y === Number(sydneyDate(now).slice(0, 4)) ? stem : `${stem} ${y}`;
}

/**
 * Splits an already-sorted list into one group per day, so each day's releases
 * sit under their own heading instead of running together.
 *
 * The incoming order is kept, which means the caller's sort decides whether
 * days run forwards or backwards. Undated items collect in a final group,
 * because there is nowhere sensible to put them in a run of dates.
 */
export function groupByDay(rows) {
  const byDate = new Map();
  const undated = [];

  for (const r of rows) {
    if (!r.date) {
      undated.push(r);
      continue;
    }
    const existing = byDate.get(r.date);
    if (existing) existing.push(r);
    else byDate.set(r.date, [r]);
  }

  const groups = [...byDate.entries()].map(([date, items]) => ({ date, items }));
  if (undated.length) groups.push({ date: null, items: undated });
  return groups;
}

/**
 * Thirty of the top fifty country albums are usually older than a year, so
 * without this the tab is mostly records you have owned for decades. A row
 * with no date is never catalogue: Apple omits the date on some brand new
 * singles, and hiding something new for want of a date is the worse error.
 *
 * Uses calendar arithmetic to compare exact years, not elapsed days, because
 * 365 days does not equal twelve calendar months. A record released exactly
 * one year ago today is therefore NOT catalogue, which matches the spec.
 *
 * The comparison is on the date strings themselves, in Sydney's calendar. That
 * keeps it clear of both the browser's timezone and the old rollover quirk,
 * where subtracting a year from 29 February landed on 1 March.
 */
export function isCatalogue(row, now = new Date()) {
  // A series is exempt. The only date the chart carries for a show is when it
  // first aired, and a show can run for a decade, so judging one by its
  // premiere would file a series airing new episodes this week alongside a
  // record from 1973. Albums and films are dated by the thing itself, so the
  // rule holds for them.
  if (row.kind === 'show') return false;
  if (!row.release_date) return false;
  const [y, rest] = splitYear(sydneyDate(now));
  return row.release_date < `${y - 1}-${rest}`;
}

/** A YYYY-MM-DD date as its year and the month-day that follows. */
function splitYear(iso) {
  return [Number(iso.slice(0, 4)), iso.slice(5)];
}

export function filterCatalogue(rows, includeCatalogue, now = new Date()) {
  return includeCatalogue ? rows : rows.filter((r) => !isCatalogue(r, now));
}

/**
 * Drops suggestions you already follow.
 *
 * The build already excludes what you own or watchlist, but "tracked" is
 * recalculated when the list is read, so anything followed since the last build
 * would otherwise sit there with a tick. Filtering here rather than at build
 * time means the row disappears the moment you press the button, instead of
 * waiting for a rebuild that takes minutes.
 */
export function dropFollowed(rows) {
  return rows.filter((s) => !s.tracked);
}

/**
 * The Lyrics tab's summary line. Covered means Plex already has the lyric,
 * stored means this app holds it, missing means neither. An instrumental has
 * nothing to find, so it is counted on its own and is neither stored nor
 * missing.
 */
/**
 * The Lyrics tab's Missing only toggle. Off, every track shows. On, only the
 * tracks with no lyrics anywhere: not in Plex, not stored here, and not
 * instrumental, since an instrumental has nothing to find.
 */
export function visibleLyricTracks(tracks, missingOnly) {
  return missingOnly ? tracks.filter((t) => t.state === 'missing') : tracks;
}

export function lyricCounts(tracks) {
  const counts = { covered: 0, stored: 0, missing: 0, instrumental: 0, total: tracks.length };
  for (const t of tracks) {
    if (t.state in counts) counts[t.state] += 1;
  }
  return counts;
}
