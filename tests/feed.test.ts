import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_TYPES,
  applyFilters,
  filtersActive,
  groupEpisodes,
  horizonCutoff,
  relativeDays,
  sydneyDate,
  filterSuggestionYears,
  DEFAULT_HORIZONS,
  DEFAULT_HELD,
  groupByDay,
  dayHeading,
  isCatalogue,
  filterCatalogue,
  dropFollowed,
  sydneyTime,
  formatWhen,
  relativeWhen,
} from '../public/feed.js';

const NOW = new Date('2026-09-19T12:00:00+10:00');

function baseFilter(overrides = {}) {
  return {
    q: '',
    types: new Set(ALL_TYPES),
    sort: 'date-desc',
    horizon: 7,
    cinema: false,
    held: true,
    ...overrides,
  };
}

function item(over: Record<string, unknown> = {}) {
  return {
    source: 'music',
    kind: 'album',
    id: Math.random().toString(36).slice(2),
    title: 'A Record',
    subtitle: 'An Artist',
    date: '2026-09-18',
    event: null,
    date_kind: null,
    group: null,
    first_seen_at: '2026-09-18T00:00:00Z',
    dismissed: 0,
    in_library: 0,
    ...over,
  };
}

/* ------------------------------------------------------------- horizons */

test('horizon looks backwards for Out now and forwards for Coming soon', () => {
  assert.equal(horizonCutoff(7, 'out', NOW), '2026-09-12');
  assert.equal(horizonCutoff(7, 'upcoming', NOW), '2026-09-26');
  assert.equal(horizonCutoff(30, 'out', NOW), '2026-08-20');
});

test('Out now keeps only what falls inside the window', () => {
  const rows = [
    item({ date: '2026-09-18', title: 'Inside' }),
    item({ date: '2026-09-12', title: 'Edge' }),
    item({ date: '2026-09-11', title: 'Too old' }),
  ];
  const kept = applyFilters(rows, baseFilter(), 'out', NOW).map((r) => r.title);
  assert.deepEqual(kept.sort(), ['Edge', 'Inside']);
});

test('Coming soon keeps only what falls inside the window', () => {
  const f = baseFilter({ sort: 'soonest' });
  const rows = [
    item({ date: '2026-09-20', title: 'Soon' }),
    item({ date: '2026-09-26', title: 'Edge' }),
    item({ date: '2026-09-27', title: 'Too far' }),
  ];
  const kept = applyFilters(rows, f, 'upcoming', NOW).map((r) => r.title);
  assert.deepEqual(kept, ['Soon', 'Edge']);
});

test('a horizon of zero means no limit', () => {
  const rows = [item({ date: '2020-01-01', title: 'Ancient' })];
  assert.equal(applyFilters(rows, baseFilter({ horizon: 0 }), 'out', NOW).length, 1);
});

/* ------------------------------------------------------------ cinema toggle */

test('cinema-only films are hidden until the box is ticked', () => {
  const rows = [
    item({ kind: 'movie', title: 'In cinemas', date_kind: 'cinema' }),
    item({ kind: 'movie', title: 'Streaming', date_kind: 'digital' }),
  ];
  const hidden = applyFilters(rows, baseFilter(), 'out', NOW).map((r) => r.title);
  assert.deepEqual(hidden, ['Streaming']);

  const shown = applyFilters(rows, baseFilter({ cinema: true }), 'out', NOW).map((r) => r.title);
  assert.equal(shown.length, 2);
});

test('the cinema toggle counts as an active filter', () => {
  assert.equal(filtersActive(baseFilter(), 'date-desc'), false);
  assert.equal(filtersActive(baseFilter({ cinema: true }), 'date-desc'), true);
  assert.equal(filtersActive(baseFilter({ horizon: 30 }), 'date-desc'), true);
});

/* -------------------------------------------------------- type and search */

test('type chips and search compose', () => {
  const rows = [
    item({ kind: 'single', title: 'A single' }),
    item({ kind: 'album', title: 'An album' }),
    item({ kind: 'movie', title: 'A film', date_kind: 'digital' }),
  ];
  const f = baseFilter({ types: new Set(['album', 'movie']) });
  assert.deepEqual(
    applyFilters(rows, f, 'out', NOW)
      .map((r) => r.title)
      .sort(),
    ['A film', 'An album'],
  );

  const searched = applyFilters(rows, baseFilter({ q: 'album' }), 'out', NOW);
  assert.deepEqual(searched.map((r) => r.title), ['An album']);
});

/* ------------------------------------------------------------- grouping */

function ep(show: string, code: string, date: string, title = 'Ep') {
  return item({
    source: 'episode',
    kind: 'show',
    group: show,
    title: show,
    subtitle: `${code} · ${title}`,
    date,
  });
}

test('several episodes of one show collapse into a single row', () => {
  const rows = [
    ep('monster', 'S04E01', '2026-09-17'),
    ep('monster', 'S04E02', '2026-09-17'),
    ep('monster', 'S04E03', '2026-09-17'),
    item({ title: 'A record' }),
  ];
  const grouped = groupEpisodes(rows, 'out');
  assert.equal(grouped.length, 2, 'three episodes plus one record becomes two rows');

  const group = grouped.find((r) => r.isGroup)!;
  assert.equal(group.episodes.length, 3);
  assert.equal(group.event, '3 episodes');
  assert.equal(group.subtitle, 'S04E01 to S04E03');
});

test('a group header carries no premiere or finale of its own', () => {
  const eps = [
    { ...ep('slowhorses', 'S05E01', '2026-09-17'), event: 'season premiere' },
    { ...ep('slowhorses', 'S05E02', '2026-09-17'), event: 'episode' },
    { ...ep('slowhorses', 'S05E06', '2026-09-17'), event: 'season finale' },
  ];
  const group = groupEpisodes(eps, 'out').find((r) => r.isGroup)!;
  assert.equal(group.event, '3 episodes');
  assert.equal(group.events, undefined);
});

test('each episode of a group keeps its own event, so the badges stay with them', () => {
  const eps = [
    { ...ep('slowhorses', 'S05E01', '2026-09-17'), event: 'season premiere' },
    { ...ep('slowhorses', 'S05E02', '2026-09-17'), event: 'episode' },
    { ...ep('slowhorses', 'S05E06', '2026-09-17'), event: 'season finale' },
  ];
  const group = groupEpisodes(eps, 'out').find((r) => r.isGroup)!;
  assert.deepEqual(
    group.episodes.map((e: { subtitle: string; event: string }) => [e.subtitle, e.event]),
    [
      ['S05E01 · Ep', 'season premiere'],
      ['S05E02 · Ep', 'episode'],
      ['S05E06 · Ep', 'season finale'],
    ],
  );
});

/* The R.J. Decker case: a run of two where only the second ends the season.
   The header names the first, so a finale badge there was a claim about the
   wrong episode. */
test('a finale later in the run never lands on the episode the header names', () => {
  const eps = [
    { ...ep('decker', 'S02E02', '2026-09-22'), event: 'episode' },
    { ...ep('decker', 'S02E03', '2026-09-29'), event: 'season finale' },
  ];
  const group = groupEpisodes(eps, 'upcoming').find((r) => r.isGroup)!;
  assert.equal(group.subtitle, 'next S02E02 · 22 September 2026');
  assert.equal(group.events, undefined);
  assert.equal(group.episodes[1]!.event, 'season finale');
});

test('a lone episode stays an ordinary row', () => {
  const grouped = groupEpisodes([ep('mobland', 'S02E01', '2026-09-18')], 'out');
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0]!.isGroup, undefined);
  assert.equal(grouped[0]!.subtitle, 'S02E01 · Ep');
});

test('different shows never merge', () => {
  const grouped = groupEpisodes(
    [ep('a', 'S01E01', '2026-09-18'), ep('b', 'S01E01', '2026-09-18')],
    'out',
  );
  assert.equal(grouped.length, 2);
});

test('Out now leads with the newest episode, Coming soon with the next', () => {
  const eps = [
    ep('x', 'S01E01', '2026-09-15'),
    ep('x', 'S01E02', '2026-09-16'),
    ep('x', 'S01E03', '2026-09-17'),
  ];
  assert.equal(groupEpisodes(eps, 'out')[0]!.date, '2026-09-17');

  const soon = [
    ep('x', 'S01E04', '2026-09-25'),
    ep('x', 'S01E05', '2026-10-02'),
  ];
  const g = groupEpisodes(soon, 'upcoming')[0]!;
  assert.equal(g.date, '2026-09-25');
  assert.match(g.subtitle, /^next S01E04 · 25 September 2026$/);
});

test('grouping keeps every episode reachable for dismissal', () => {
  const eps = [ep('x', 'S01E01', '2026-09-17'), ep('x', 'S01E02', '2026-09-17')];
  const ids = new Set(eps.map((e) => e.id));
  const group = groupEpisodes(eps, 'out')[0]!;
  assert.deepEqual(new Set(group.episodes.map((e: { id: string }) => e.id)), ids);
});

/* -------------------------------------------------------------- relative */

test('relativeDays reads naturally around today', () => {
  assert.equal(relativeDays('2026-09-19', NOW), 'today');
  assert.equal(relativeDays('2026-09-20', NOW), 'tomorrow');
  assert.equal(relativeDays('2026-09-18', NOW), 'yesterday');
  assert.equal(relativeDays('2026-09-26', NOW), 'in 7 days');
  assert.equal(relativeDays('2026-09-12', NOW), '7 days ago');
});

/* ------------------------------------------------------------ in library */

test('things already in Plex are shown by default, not hidden', () => {
  const rows = [
    item({ title: 'Already have it', in_library: 1 }),
    item({ title: 'Still to get', in_library: 0 }),
  ];
  const shown = applyFilters(rows, baseFilter(), 'out', NOW).map((r) => r.title);
  assert.equal(shown.length, 2, 'both should show so the tick means something');
});

test('unticking In library hides what is already held', () => {
  const rows = [
    item({ title: 'Already have it', in_library: 1 }),
    item({ title: 'Still to get', in_library: 0 }),
  ];
  const shown = applyFilters(rows, baseFilter({ held: false }), 'out', NOW).map((r) => r.title);
  assert.deepEqual(shown, ['Still to get']);
});

test('unticking In library counts as an active filter', () => {
  assert.equal(filtersActive(baseFilter({ held: true }), 'date-desc'), false);
  assert.equal(filtersActive(baseFilter({ held: false }), 'date-desc'), true);
});

test('a run of episodes counts as held only when every one is held', () => {
  const partial = groupEpisodes(
    [
      ep('x', 'S01E01', '2026-09-15'),
      { ...ep('x', 'S01E02', '2026-09-16'), in_library: 1 },
    ],
    'out',
  )[0]!;
  assert.equal(partial.in_library, 0, 'one of two held is not "in Plex"');
  assert.equal(partial.heldCount, 1);

  const full = groupEpisodes(
    [
      { ...ep('x', 'S01E01', '2026-09-15'), in_library: 1 },
      { ...ep('x', 'S01E02', '2026-09-16'), in_library: 1 },
    ],
    'out',
  )[0]!;
  assert.equal(full.in_library, 1);
  assert.equal(full.heldCount, 2);
});

test('hiding held items also hides a fully held run', () => {
  const eps = [
    { ...ep('x', 'S01E01', '2026-09-15'), in_library: 1 },
    { ...ep('x', 'S01E02', '2026-09-16'), in_library: 1 },
  ];
  const grouped = groupEpisodes(eps, 'out');
  const visible = grouped.filter((r) => r.in_library !== 1);
  assert.equal(visible.length, 0);
});

/* -------------------------------------------------- suggestion year filter */

const sg = (over: Record<string, unknown> = {}) => ({
  kind: 'movie',
  id: 'tmdb://movie/1',
  title: 'A Film',
  subtitle: '',
  year: 2026,
  seeds: ['Something'],
  ...over,
});

test('a film from a previous year is hidden by default', () => {
  const rows = filterSuggestionYears([sg({ year: 2019 })], false, NOW);
  assert.equal(rows.length, 0);
});

test('a film from this year is kept', () => {
  const rows = filterSuggestionYears([sg({ year: 2026 })], false, NOW);
  assert.equal(rows.length, 1);
});

test('a film dated ahead of this year is kept', () => {
  const rows = filterSuggestionYears([sg({ year: 2027 })], false, NOW);
  assert.equal(rows.length, 1);
});

test('a film with no year is kept rather than hidden', () => {
  const rows = filterSuggestionYears([sg({ year: null })], false, NOW);
  assert.equal(rows.length, 1);
});

test('artists carry no year and are never hidden by it', () => {
  const rows = filterSuggestionYears([sg({ kind: 'artist', year: null })], false, NOW);
  assert.equal(rows.length, 1);
});

test('including previous years brings the old films back', () => {
  const rows = filterSuggestionYears([sg({ year: 1998 }), sg({ year: 2026 })], true, NOW);
  assert.equal(rows.length, 2);
});

/* --------------------------------------------- the window the badge counts */

test('Out now defaults to the whole window the server sent, matching the badge', () => {
  assert.equal(DEFAULT_HORIZONS.out, 0);
});

test('Coming soon still defaults to the next 7 days', () => {
  assert.equal(DEFAULT_HORIZONS.upcoming, 7);
});

test('the Out now default window is not counted as a filter the user chose', () => {
  const f = baseFilter({ horizon: DEFAULT_HORIZONS.out });
  assert.equal(filtersActive(f, 'date-desc', DEFAULT_HORIZONS.out), false);
});

test('narrowing Out now to a week does count as a chosen filter', () => {
  const f = baseFilter({ horizon: 7 });
  assert.equal(filtersActive(f, 'date-desc', DEFAULT_HORIZONS.out), true);
});

test('Out now opens with what you already have hidden', () => {
  assert.equal(DEFAULT_HELD.out, false);
});

test('Coming soon still opens showing everything', () => {
  assert.equal(DEFAULT_HELD.upcoming, true);
});

test('the Out now default of hiding held items is not a filter the user chose', () => {
  const f = baseFilter({ horizon: DEFAULT_HORIZONS.out, held: DEFAULT_HELD.out });
  assert.equal(filtersActive(f, 'date-desc', DEFAULT_HORIZONS.out, DEFAULT_HELD.out), false);
});

test('turning the Out now hide-what-I-have toggle off does count as a chosen filter', () => {
  const f = baseFilter({ horizon: DEFAULT_HORIZONS.out, held: true });
  assert.equal(filtersActive(f, 'date-desc', DEFAULT_HORIZONS.out, DEFAULT_HELD.out), true);
});

/* ------------------------------------------------------- grouping by day */

test('items on the same day land in one group', () => {
  const groups = groupByDay([
    item({ date: '2026-09-25', title: 'One' }),
    item({ date: '2026-09-25', title: 'Two' }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.items.length, 2);
});

test('each day becomes its own group, in the order it was given', () => {
  const groups = groupByDay([
    item({ date: '2026-09-25' }),
    item({ date: '2026-09-26' }),
    item({ date: '2026-09-25' }),
  ]);
  assert.deepEqual(groups.map((g) => g.date), ['2026-09-25', '2026-09-26']);
  assert.equal(groups[0]!.items.length, 2);
});

test('undated items group together at the end', () => {
  const groups = groupByDay([item({ date: null }), item({ date: '2026-09-25' })]);
  assert.equal(groups[groups.length - 1]!.date, null);
});

test('a day heading names the weekday, because that is what you scan for', () => {
  assert.equal(dayHeading('2026-09-25', NOW), 'Friday 25 September');
});

test('a day in another year says so', () => {
  assert.equal(dayHeading('2027-01-04', NOW), 'Monday 4 January 2027');
});

test('undated items get a heading rather than a blank one', () => {
  assert.equal(dayHeading(null, NOW), 'Date unknown');
});

test('grouping loses nothing', () => {
  const rows = [
    item({ date: '2026-09-25' }),
    item({ date: null }),
    item({ date: '2026-09-26' }),
    item({ date: '2026-09-25' }),
  ];
  const total = groupByDay(rows).reduce((n, g) => n + g.items.length, 0);
  assert.equal(total, rows.length);
});

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

test('released exactly one year before now is not catalogue', () => {
  const now = new Date('2025-09-19T12:00:00+10:00');
  assert.equal(isCatalogue(chart({ release_date: '2024-09-19' }), now), false);
});

test('released one day before the one-year mark is catalogue', () => {
  const now = new Date('2025-09-19T12:00:00+10:00');
  assert.equal(isCatalogue(chart({ release_date: '2024-09-18' }), now), true);
});

test('366 elapsed days still triggers catalogue because it is before the calendar year boundary', () => {
  const now = new Date('2025-01-01T12:00:00+10:00');
  assert.equal(isCatalogue(chart({ release_date: '2023-01-01' }), now), true);
});

test('one calendar year spanning 29 February is not catalogue, unlike raw day counting', () => {
  const now = new Date('2025-01-01T12:00:00+10:00');
  assert.equal(isCatalogue(chart({ release_date: '2024-01-01' }), now), false);
});

/* ------------------------------------------ suggestions already followed */

const sgf = (over: Record<string, unknown> = {}) => ({
  kind: 'artist',
  id: 'mbid-1',
  title: 'An Artist',
  year: null,
  tracked: false,
  ...over,
});

test('an artist you already follow drops off the suggestions', () => {
  assert.equal(dropFollowed([sgf({ tracked: true })]).length, 0);
});

test('one you do not follow stays', () => {
  assert.equal(dropFollowed([sgf()]).length, 1);
});

test('only the followed ones go, the rest are untouched', () => {
  const rows = dropFollowed([sgf({ id: 'a', tracked: true }), sgf({ id: 'b' })]);
  assert.deepEqual(rows.map((r) => r.id), ['b']);
});

test('a followed film drops off too, not just artists', () => {
  assert.equal(dropFollowed([sgf({ kind: 'movie', tracked: true })]).length, 0);
});

test('the order of what remains is not disturbed', () => {
  const rows = dropFollowed([
    sgf({ id: 'a' }),
    sgf({ id: 'b', tracked: true }),
    sgf({ id: 'c' }),
  ]);
  assert.deepEqual(rows.map((r) => r.id), ['a', 'c']);
});

/* --------------------------------- shows are exempt from the catalogue rule */

test('a show that first aired years ago is not catalogue', () => {
  // It is on the chart because people are watching it now, and a series can run
  // for a decade. Its premiere date says nothing about whether it is current.
  assert.equal(isCatalogue({ kind: 'show', release_date: '2019-04-01' }, NOW), false);
});

test('an old album is still catalogue', () => {
  assert.equal(isCatalogue({ kind: 'album', release_date: '1973-09-01' }, NOW), true);
});

test('an old film is still catalogue', () => {
  assert.equal(isCatalogue({ kind: 'movie', release_date: '1998-09-01' }, NOW), true);
});

test('hiding catalogue leaves every show in place', () => {
  const rows = [
    { kind: 'show', release_date: '2019-04-01' },
    { kind: 'album', release_date: '1973-09-01' },
  ];
  const kept = filterCatalogue(rows, false, NOW);
  assert.deepEqual(kept.map((r) => r.kind), ['show']);
});

/* ------------------------------------------------------ Sydney, not local */

/**
 * The page decides what "today" means, and the server decides what is out and
 * what is upcoming. If the page used the machine's clock the two would
 * disagree whenever the browser is set to another zone, so every one of these
 * uses an instant where Sydney and the Americas are on different days, and
 * asserts the Sydney answer. They pass on a machine set to any timezone.
 */

// 15:00 UTC on 21 September 2026 is already the 22nd in Sydney, and still the
// 21st everywhere in the Americas.
const CROSSOVER = new Date('2026-09-21T15:00:00Z');

// 14:00 UTC on 31 December 2026 is New Year's Day in Sydney, and still 2026
// in London and the Americas.
const SYDNEY_NEW_YEAR = new Date('2026-12-31T14:00:00Z');

test('the calendar date is read in Sydney, not wherever the machine is set', () => {
  assert.equal(sydneyDate(CROSSOVER), '2026-09-22');
  assert.equal(sydneyDate(SYDNEY_NEW_YEAR), '2027-01-01');
});

test('a release out today in Sydney does not read as tomorrow', () => {
  assert.equal(relativeDays('2026-09-22', CROSSOVER), 'today');
  assert.equal(relativeDays('2026-09-23', CROSSOVER), 'tomorrow');
  assert.equal(relativeDays('2026-09-21', CROSSOVER), 'yesterday');
});

test('a horizon covers the Sydney week, not the machine week', () => {
  assert.equal(horizonCutoff(7, 'out', CROSSOVER), '2026-09-15');
  assert.equal(horizonCutoff(7, 'upcoming', CROSSOVER), '2026-09-29');
});

test('a horizon crossing a month end still counts calendar days', () => {
  assert.equal(horizonCutoff(30, 'out', CROSSOVER), '2026-08-23');
});

test('on New Year in Sydney, last year stops counting as this year', () => {
  assert.equal(filterSuggestionYears([sg({ year: 2026 })], false, SYDNEY_NEW_YEAR).length, 0);
  assert.equal(filterSuggestionYears([sg({ year: 2027 })], false, SYDNEY_NEW_YEAR).length, 1);
});

test('the year is dropped from a heading once Sydney is in that year', () => {
  assert.equal(dayHeading('2027-01-04', SYDNEY_NEW_YEAR), 'Monday 4 January');
  assert.equal(dayHeading('2026-12-31', SYDNEY_NEW_YEAR), 'Thursday 31 December 2026');
});

test('the weekday on a heading is the date itself, in any timezone', () => {
  assert.equal(dayHeading('2026-09-22', CROSSOVER), 'Tuesday 22 September');
});

test('the catalogue cutoff moves with the Sydney day, not the machine day', () => {
  // A year before 22 September 2026 in Sydney. The 21st is catalogue, the
  // 22nd is not, and a machine still on the 21st would get both wrong.
  assert.equal(isCatalogue(chart({ release_date: '2025-09-22' }), CROSSOVER), false);
  assert.equal(isCatalogue(chart({ release_date: '2025-09-21' }), CROSSOVER), true);
});

/**
 * The old implementation subtracted a year with setFullYear, which rolls 29
 * February over to 1 March, moving the boundary by a day every four years.
 * Comparing the dates as strings has no such edge.
 */
test('the one-year boundary holds on 29 February', () => {
  const leapDay = new Date('2028-02-29T01:00:00+11:00');
  assert.equal(isCatalogue(chart({ release_date: '2027-03-01' }), leapDay), false);
  assert.equal(isCatalogue(chart({ release_date: '2027-02-28' }), leapDay), true);
});

/* ------------------------------------------------- release times */

/*
 * Episodes carry a real instant from TVMaze (see src/airtimes.ts). Anything
 * without one, a record or a film or a show TVMaze does not schedule, can only
 * honestly be shown to the day.
 */
test('a Sydney release time is read off the instant', () => {
  // Ted Lasso S04E08: noon UTC is 10pm in Sydney.
  assert.equal(sydneyTime('2026-09-23T12:00:00+00:00'), '10:00 pm');
  // R.J. Decker S02E02: 22:00 in New York is noon here the next day.
  assert.equal(sydneyTime('2026-09-23T02:00:00+00:00'), '12:00 pm');
  assert.equal(sydneyTime('2026-09-22T14:30:00+00:00'), '12:30 am');
});

test('an item with no instant has no time', () => {
  assert.equal(sydneyTime(null), '');
  assert.equal(sydneyTime(undefined), '');
  assert.equal(sydneyTime('not a date'), '');
});

test('the date carries the time only when one is known', () => {
  assert.equal(formatWhen('2026-09-23', '2026-09-23T12:00:00+00:00'), '23 September 2026, 10:00 pm');
  assert.equal(formatWhen('2026-09-23', null), '23 September 2026');
  assert.equal(formatWhen(null, null), '');
});

/*
 * A 10pm episode is not out at breakfast. Saying "today" from midnight is the
 * same mistake as the one that had shows out a day early, just smaller, so a
 * stamp still ahead of now reads as later today.
 */
test('an instant still to come today reads as later today', () => {
  const morning = new Date('2026-09-23T00:00:00+10:00'); // midnight Sydney
  assert.equal(relativeWhen('2026-09-23', '2026-09-23T12:00:00+00:00', morning), 'later today');
});

test('an instant that has passed reads as today', () => {
  const night = new Date('2026-09-23T23:00:00+10:00'); // 11pm Sydney, after the 10pm drop
  assert.equal(relativeWhen('2026-09-23', '2026-09-23T12:00:00+00:00', night), 'today');
});

test('other days are unaffected by the time of day', () => {
  const now = new Date('2026-09-22T09:00:00+10:00');
  assert.equal(relativeWhen('2026-09-23', '2026-09-23T12:00:00+00:00', now), 'tomorrow');
  assert.equal(relativeWhen('2026-09-21', '2026-09-21T12:00:00+00:00', now), 'yesterday');
  assert.equal(relativeWhen('2026-09-29', '2026-09-29T12:00:00+00:00', now), 'in 7 days');
});

test('without an instant the day-level wording is unchanged', () => {
  const now = new Date('2026-09-22T09:00:00+10:00');
  assert.equal(relativeWhen('2026-09-22', null, now), relativeDays('2026-09-22', now));
  assert.equal(relativeWhen('2026-09-23', null, now), 'tomorrow');
});
