# Air times design

Date: 20/09/2026

Shows the local time an episode airs, on the shows that have one, and corrects
the day an episode lands on in the feeds. Both come from the same lookup.

## What was verified before designing

Measured against the real watchlist, not assumed.

Plex carries no time. A Discover episode's only date-shaped field is
`originallyAvailableAt`, a bare `YYYY-MM-DD`. There is nothing being discarded;
the data simply is not there. `src/episodes.ts` already validates against a
date-only pattern, which is correct for what Plex returns.

TVmaze has times, needs no API key, and matched 19 of the 20 most recently
active continuing shows on the watchlist by title. Of those 19, four carry a
real broadcast time:

| Show | Time | Where |
| --- | --- | --- |
| Anna Pigeon | 22:00 America/New_York | USA Network |
| R.J. Decker | 22:00 America/New_York | ABC |
| Lanterns | 21:00 America/New_York | HBO |
| Ann Droid | 06:00 Europe/London | BBC iPlayer |

The other fifteen are Netflix, Apple TV, Prime Video, Paramount+, Hulu and MGM+.
Streaming services do not broadcast, so no time exists for them and TVmaze
returns an empty string rather than a guess. One show did not match at all.

So a time will appear on roughly one show in five. Films and music have no times
from any source and are out of scope entirely.

## The more important half

Anna Pigeon airs at 22:00 in New York on a Friday. That is 2pm on the Saturday
in Sydney.

The feeds currently show the bare date Plex supplies, which is the broadcaster's
local date, so a late-night American show is already listed a day earlier than
it can be watched here. That is wrong today, independently of whether any time
is ever displayed, and the same lookup fixes it.

This matters more than the cosmetic half, because the date decides which day
heading an episode sits under in Out now and Coming soon, and whether it counts
as out or still upcoming.

## Decisions

- TVmaze is the source. No key, and it is the only free source carrying
  broadcast times.
- A show with no broadcast time shows exactly what it shows today. No
  placeholder, no "time unknown". The absence of a time is not a gap.
- Times are displayed in Australia/Sydney, like every other date in this app,
  and never in the broadcaster's zone.
- Matching is by title, and a failure is recorded rather than guessed at. One in
  twenty already fails, and the wrong show's schedule is worse than none.
- Nothing about a film or an album changes.

## Getting the time

One lookup per show, not per episode. A series has a schedule; its episodes
inherit it.

`GET /api/tvmaze/singlesearch/shows?q=<title>` returns the show with
`schedule.time`, `schedule.days`, and the network or web channel carrying a
country with an IANA `timezone`. Those three are what is needed: a wall-clock
time, and the zone it is a wall-clock time in.

The episode list at `/shows/{id}/episodes` also carries a per-episode `airstamp`,
which is already an absolute instant. Where an episode has a real one, it is
preferred over recomposing the show's schedule, because a special or a finale
can air off the usual slot. TVmaze fills `airstamp` with a synthetic midday UTC
value when it has no real time, so an airstamp is only trusted when the show has
a non-empty `schedule.time`.

TVmaze asks for gentle use rather than publishing a hard limit. Lookups are
spaced 350 milliseconds apart, and the answer is cached for a fortnight, keyed
on the show's watchlist rating key. Seventy-nine continuing shows is therefore
about thirty seconds on a first run and nothing on later ones.

## Converting to Sydney

The broadcaster's wall-clock time plus its IANA zone gives an absolute instant.
That instant is then rendered in Australia/Sydney.

`src/dates.ts` already owns Sydney-relative dates and is where this belongs. The
conversion uses `Intl.DateTimeFormat` with an explicit `timeZone`, which is in
Node and needs no dependency and no table of offsets. Daylight saving on both
ends is handled by the platform rather than by arithmetic, which is the whole
reason not to do this by hand.

Two values come out: the Sydney calendar date, which replaces the stored
`air_date` for feed purposes, and the Sydney wall-clock time, which is what the
row displays.

## What changes in the feeds

An episode row gains a time when one is known. "S02E05 · 20 November" becomes
"S02E05 · Saturday 21 November, 2pm", the day having moved because the time
moved it.

Times read as 1pm and 9.30pm rather than 13:00 and 21:30, matching how the rest
of the app writes for a person rather than a machine. Midnight and noon are
written as such.

The day headings already added to both feeds pick up the corrected date for
free, since they group on whatever date the row carries.

A show with no known time keeps the Plex date exactly as now. No conversion is
applied, because converting a date with no time attached would be inventing
precision that does not exist.

## Storage

```
show_schedules
  rating_key   the watchlist show, primary key
  tvmaze_id    null when the title did not match
  air_time     "22:00", or null when the show does not broadcast
  air_zone     IANA zone, for example America/New_York
  days         JSON array of weekday names, for display only
  checked_at
```

The episodes table gains two nullable columns, filled only when a time is known:

```
episodes
  ...
  local_date   the Sydney calendar date, when it differs from air_date
  local_time   the Sydney wall-clock time, "13:00"
```

Storing the converted values rather than converting on read keeps the feed
queries unchanged. They already sort and window on a date column; they simply
use `COALESCE(local_date, air_date)`.

A failed title match is stored with a null `tvmaze_id` and retried after the
fortnight, the same shape the artist cache uses, and for the same reason: a show
TVmaze does not carry should not be asked about on every sync.

## Modules

`src/tvmaze.ts`
The only module that knows TVmaze. The search, the schedule shape, the gentle
spacing and the cache.

`src/dates.ts` gains `toSydney(date, time, zone)`, returning the Sydney date and
time, and `formatTime` for the "1pm" rendering. It already owns the timezone
question and should keep owning it.

`src/episodes.ts` fills the two new columns during its existing sync and returns
them in its feed rows.

`public/feed.js` gains the time into the episode subtitle. It is pure formatting
and is tested there.

## Testing

`tests/tvmaze.test.ts` and additions to `tests/dates.test.ts`, all pure, no
network.

- A show with an empty `schedule.time` yields no time rather than a zero time.
- A synthetic midday-UTC airstamp is refused when the show has no schedule time.
- 22:00 America/New_York on Friday 20 November converts to Saturday 21
  November, 2pm Sydney.
- The same broadcast time in June converts to 12pm, not 2pm. Verified against
  Node's own timezone data: New York is on daylight saving in June and not in
  November, Sydney is the reverse, and the two shifts compound to two hours.
  This single case is the reason the conversion must go through Intl rather
  than any stored offset, and it is the test most likely to catch a regression.
- 06:00 Europe/London on 20 November stays on 20 November, at 5pm Sydney, so a
  time that does not cross midnight leaves the date alone.
- Times render as 1pm, 9.30pm, midnight and noon.
- A show TVmaze does not carry yields a null match, not a throw.

## Out of scope

- Air times for films. No source carries them, because a cinema release is a
  date, not a screening.
- Music release times. MusicBrainz records a date.
- Per-episode schedule overrides beyond what `airstamp` already gives.
- Treating a streaming drop as an air time. A drop has no hour, and inventing
  one would be worse than showing nothing.
- Notifying when something is about to air. Out of scope for this app entirely.
