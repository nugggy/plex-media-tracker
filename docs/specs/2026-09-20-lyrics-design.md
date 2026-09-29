# Lyrics design

Date: 20/09/2026

Finds which tracks in the Plex music library have no lyrics, fetches them from
LRCLIB, and stores them in the app so they can be read in the dashboard. It
writes nothing to the music library.

## What was verified before designing

All of this was probed against the real server, not assumed.

Plex exposes lyrics as a stream of type 4 on a track, tagged `lrc` or `txt`, so
"does this track have lyrics" is a direct read with no guessing. In a sample of
twelve tracks, five had one and seven did not.

The music library holds 1,235 tracks. That is small enough that a whole-library
sweep is practical, though this design still works an artist or an album at a
time, as asked.

Track metadata carries everything a lyrics lookup needs: title, artist as
`grandparentTitle`, album as `parentTitle`, and duration in milliseconds.

LRCLIB answers without an API key. `GET /api/get` with artist, track, album and
duration returns plain lyrics and time-synced lyrics in the same response, plus
an `instrumental` flag. `GET /api/search` returns candidates when the exact
lookup misses.

Plex reports each track's file path as the Plex server sees it, for example
`/share/CACHEDEV1_DATA/Nuggy NAS Shared Folder/PLEX Library/Music/Kryptonite.mp3`.
That is a NAS path this PC cannot write to, and Plex has no API for uploading
lyrics to a music track. Writing lyrics into the library would therefore need a
path translation supplied by hand. That half is deliberately not built yet.

## Decisions

- Lyrics live in the app's own database. Nothing is written to the music
  library, so nothing in the library can be damaged.
- Work happens one artist or one album at a time, chosen in the dashboard.
- Synced lyrics are taken when LRCLIB has them, plain lyrics otherwise. Both
  arrive in one response, so taking the better one costs nothing.
- A track LRCLIB marks instrumental is recorded as instrumental, not as missing.
  An instrumental has no lyrics to find and should not sit on a to-do list
  forever.
- Nothing is fetched automatically. Every lookup is a deliberate press, like
  Suggestions and unlike the watchlist sync.
- Lyrics can also be pasted in by hand, for the tracks LRCLIB does not carry.

## Reading what Plex already has

`src/plex.ts` gains `fetchTracks`, listing the tracks of one artist or one
album with their rating key, title, album, duration and whether a type 4 stream
is present.

A track is **covered** when Plex already has lyrics for it. It is **stored**
when this app holds lyrics for it. It is **missing** when neither is true and it
is not known to be instrumental. The report is the missing list, and it is the
point of the feature.

Covered and stored are kept apart deliberately. A track Plex already covers
needs nothing. A track this app has stored is readable here but still absent
from Plex, which is exactly the gap the unbuilt half would close.

## Matching a track to a lyric

The exact lookup comes first: artist, title, album and duration together.
LRCLIB matches duration within a couple of seconds, which is what stops a
different recording of the same song being accepted.

When that misses, the search endpoint is tried with artist and title only, and a
candidate is accepted only when its duration is within three seconds of the
track's. Anything else is reported as not found rather than guessed at, on the
same reasoning as the YouTube resolver: no lyric is better than the wrong lyric.

A miss is recorded with the time it was attempted, so a second press does not
re-ask LRCLIB about the same track within a fortnight. A track that genuinely
has no lyrics anywhere would otherwise be looked up on every single run.

## Rate and courtesy

LRCLIB publishes no hard rate limit but asks for an identifying User-Agent,
which this app sends as its own name and version. Lookups are spaced 200
milliseconds apart. An album of twelve tracks therefore takes a few seconds, and
the largest artist in the library takes well under a minute, so this needs none
of the machinery the MusicBrainz one-per-second limit forced on the music scan.

## Storage

```
lyrics
  rating_key    Plex track key, primary key
  artist
  title
  album
  duration_ms
  source        lrclib | manual
  synced        the timed lyric, or null
  plain         the plain lyric, or null
  instrumental  0 or 1
  fetched_at
```

```
lyrics_misses
  rating_key  primary key
  tried_at
```

A miss is its own table rather than a null row in `lyrics`, so "we hold nothing
for this track" and "we looked and LRCLIB has nothing" stay distinguishable. The
first is a track nobody has asked about; the second is a dead end worth
remembering for a fortnight.

## The tab

A Lyrics tab, built from the existing card and row patterns.

An artist picker, defaulting to the artists already in the library, then a list
of that artist's albums. Choosing either lists its tracks with a state on each:
a green tick for covered, a quieter tick for stored, and nothing for missing. A
summary line says how many of each, since that count is the answer to the
question that prompted this.

**Find lyrics** fetches for every missing track in the current view, with the
progress strip the rest of the app uses. **Read** opens the stored lyric in the
card, the way the trailer player opens. **Paste lyrics** takes text by hand for
one track, stored with source `manual`.

Nothing here offers to write to Plex, because that half does not exist. There is
no disabled button and no greyed-out promise. The README says why.

## Modules

`src/lyrics.ts`
LRCLIB, the matching rules, the miss cache and the storage. The only module that
knows the LRCLIB shapes.

`src/plex.ts` gains `fetchTracks`, since it is already the only module that
talks to the local Plex server and should stay so.

`src/api.ts` gains `/api/lyrics/tracks`, `/api/lyrics/fetch`,
`/api/lyrics/progress`, `/api/lyrics/one` and `/api/lyrics/manual`.

`public/app.js` gains the tab, and `public/feed.js` gains the pure counting of
covered, stored and missing so it can be tested without a DOM.

## Testing

`tests/lyrics.test.ts`, all pure, no network, as every other test in this
project.

- Parsing an LRCLIB response into a stored lyric, with synced preferred over
  plain, and plain used when synced is absent.
- An instrumental response stored as instrumental rather than as a lyric.
- Duration matching: a candidate three seconds out is accepted, one ten seconds
  out is refused.
- A search result by a different artist is refused even when the title matches.
- The covered, stored and missing counts, including that an instrumental counts
  as neither missing nor stored.

## Out of scope

- Writing `.lrc` files into the music library. It needs a path translation from
  the NAS path Plex reports to whatever this PC uses to reach the same folder,
  and that has to be supplied and verified by hand. When it is built it gets a
  dry run listing every file it would create, never overwrites an existing
  lyrics file, and records what it wrote so it can be undone.
- Embedding lyrics into the audio file's tags. Rewriting the files themselves is
  a much larger risk than a sidecar, for no extra benefit.
- Translating lyrics, or any other processing of them.
- Lyrics for anything that is not a track in the local music library. The
  watchlist and the trending charts have no tracks.

## Amended 29/09/2026

Two things changed after the tab had been used.

The list endpoints do not carry the streams after all. An album's children, an
artist's allLeaves and a section's allLeaves all answer without any Stream
array, whatever include parameter is sent, so read from a list alone every
track looked Missing. A metadata request for several keys at once,
`/library/metadata/1,2,3`, does carry them: 173 keys came back with their
streams in a third of a second. `fetchTracks` now takes the keys from the list
and the streams from batched metadata requests, one hundred keys a time. Read
that way, Zach Bryan's 173 tracks are 94 covered, not 0.

The tab can now look at the whole library, not only one artist. The section's
allLeaves lists all 1,270 tracks, and with the stream batches the sweep takes
about five seconds. A Missing only toggle hides every track that is covered,
stored or instrumental, which is the report the feature was built for. It is a
view filter only: the counts and Find lyrics still work on everything listed.
