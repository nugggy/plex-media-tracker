# Watchlist tracking design

Date: 19/09/2026

Extends Wax Wrangler to track films and TV shows from the Plex Watchlist
alongside music releases, with two-way removal.

## What was verified before designing

- The account token already stored reads the watchlist at
  `discover.provider.plex.tv`. 309 items, 168 shows and 141 films.
- `addToWatchlist` and `removeFromWatchlist` both return 200 and take effect.
  Tested by adding a throwaway title and removing it, list restored to 309.
- Watchlist items carry `plex://movie/<id>` and `plex://show/<id>` GUIDs, and
  the local server uses the same GUIDs. Library matching is an exact ID match,
  unlike the fuzzy title matching the music side needs.
- Shows carry `lastEpisodeOriginallyAvailableAt`, `lastSeasonOriginallyAvailableAt`,
  `childCount`, `leafCount` and `isContinuingSeries`. New episodes are detected by
  watching those values move between syncs.
- No streaming availability is returned on any endpoint. The app can say a film
  is released; it cannot say where to watch it.

## Cost

The whole watchlist is one request per 100 items, so four requests. There is no
published rate limit and no third-party service. A watchlist sync takes seconds,
unlike the music scan which is bound by the MusicBrainz one-per-second limit.

## What counts as worth showing

Films and shows behave differently and are treated differently.

A **film** is coming soon when its release date is in the future. It is out now
when its release date falls inside the recent window and its GUID is not in the
local movie sections. Once it lands on the server it drops off, matching how
music works.

A **show** is coming soon when it has not premiered yet. It is out now when its
last episode date falls inside the recent window. The library check does not
gate shows, because episodes keep arriving after the series itself is on the
server. A show that gains a season also reports, flagged as a new season rather
than a new episode.

The release date Plex gives for a film is its release date, usually cinema. It
is not a date the film can be watched at home. The "not in your library" check is
what makes the list actionable.

## Two-way removal

Plex offers no webhook for watchlist changes, so the app polls and does a
three-way merge. Every item stores its current state and the baseline, meaning
the state Plex and the app last agreed on.

| baseline | in Plex now | app state | meaning | action |
| --- | --- | --- | --- | --- |
| listed | yes | listed | unchanged | refresh metadata |
| listed | no | listed | removed in Plex | mark removed locally |
| listed | yes | removed | removed in the app | push removal to Plex |
| removed | yes | removed | added again in Plex | mark listed |
| absent | yes | absent | new item | insert as listed |

Adding is Plex-only by design. The app never adds, so it cannot resurrect
something deliberately dropped.

### Safeguards

Removal writes to a real Plex account and is not easily undone, so three rules
apply.

The first sync on an empty database imports only. It never pushes a removal, so
a fault on day one cannot empty the list.

Every removal, from either side, is written to `watchlist_removals` with enough
detail to restore it. The Watchlist tab offers undo.

If a single sync would push more than ten removals at once, it stops and reports
instead of proceeding. That is a fault, not a workflow.

## Modules

`src/plexdiscover.ts`
The only module talking to `discover.provider.plex.tv`. Reads the watchlist,
adds, removes, and searches. Nothing else knows the endpoint shape.

`src/watchlist.ts`
The three-way merge, the change detection for shows, and the safeguards.

`src/plex.ts` gains `fetchLibraryGuids`, which lists the GUIDs held in the local
film and TV sections so the library check can run.

`src/db.ts` gains three tables.

- `watchlist_items` keyed by Discover rating key, holding metadata, `in_library`,
  `state`, `baseline` and the previous episode date for change detection.
- `watchlist_removals`, the restore log.
- `library_guids`, the GUIDs held locally, replaced on each sync.

## Interface

Films and shows join the existing feeds rather than taking their own tabs. The
type chips on Out now and Coming soon gain Films and Shows next to Albums, EPs
and Singles, so one screen answers "what is out that I care about".

A Watchlist tab lists all items with their state, a remove button, and undo for
anything recently removed. It mirrors the Artists tab.

Settings gains the film and TV sections to check against, discovered the same way
the music library is.

## Out of scope

Adding to the watchlist from the app. Streaming availability. Episode-level
tracking below the level of "the last episode date moved". Notifications.
