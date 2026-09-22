# Plex Media Tracker

Tracks what is out and what is coming for the things you care about: new records
from the artists in your Plex music library, and films and episodes from your
Plex watchlist. Runs entirely on this PC.

## Getting started

You need Node 24 or newer. Check with `node --version`.

1. Double-click `start-plex-media-tracker.cmd`. It opens <http://localhost:7000>.
2. Go to Settings, add your Plex server URL and token, press Test connection,
   pick your music library, and save.
3. Press Scan now.

### Finding your Plex token

In Plex, open any album, choose Get Info, then View XML. The address bar of the
page that opens ends in `X-Plex-Token=...`. That value is the token. The same
token reaches your watchlist, because it is an account token.

## Keeping it current

One button, **Check for updates**, does everything, in two steps.

Step 1 is quick, a couple of minutes. It re-reads your Plex library, syncs the
watchlist, pulls episode schedules and checks film release dates. None of it
touches MusicBrainz.

Step 2 asks MusicBrainz about your artists, and MusicBrainz allows only one
request per second. It only asks about artists not checked in the last week, so
most runs are short. The first run, or one after a long gap, takes twenty to
forty minutes.

The progress strip says which step is running. You can press Stop at any point
and everything done so far is saved.

Step 1 also runs on its own each time the app starts, so opening the dashboard
shows current watchlist and episode information without you pressing anything.
Turn that off in Settings if you would rather it did not.

## The tabs

**Out now** is what has landed recently. It opens on the whole window the app
tracks, which is the "treat a release as recent for" setting, so the list and
the number on the tab cover the same period. It also opens with **Hide what I
have** ticked, so the list is what is still to get. Untick it to see everything
that has landed, including what is already on your server. Those rows carry a
green **In Plex** tick. For shows the tick is per episode, not per series, so an
aired episode you have not downloaded stays unticked.

The number on the tab counts what there is still for you to get, so it leaves
out anything already on your server and anything showing only in cinemas. On the
default view the two match. Untick Hide what I have, or tick Cinema, and there
will be more rows on screen than the tab counts.

**Coming soon** is what is dated ahead. Defaults to the next 7 days. Both feeds
carry the same controls: a search box, type chips for Albums, EPs, Singles,
Films and Shows, a sort order, and the time window.

Both feeds group by day, under a heading naming the weekday and how far off it
is, so you can see what lands on each day. Headings appear only while the list
is in date order, since under Title A to Z they would fragment into one heading
per row.

When several episodes of one series arrive together, they collapse into one row
showing the range, which opens to list them individually. A weekly show stays a
single ordinary row.

Episodes are badged with what they are. The first episode of a series is a
series premiere, the first of any later season a season premiere, and the last
of a season a season finale, which becomes a series finale once Plex stops
calling the show continuing. A finale is only named once Plex lists the whole
season, because it announces a season a few episodes at a time and the newest
row is usually just the newest announced. A badge always sits beside the episode
it describes, so a collapsed run of several episodes carries none of its own:
open the row to see which episode is the premiere or the finale.

**Watchlist** is your Plex watchlist, 309 items at last count. Removing here
removes it from Plex as well, and removing it in Plex removes it here. There is
an undo for the last removal.

**Artists** lists everything watched for music. The status dropdown finds
artists that could not be matched, and Fix lets you choose between artists
sharing a name or paste a MusicBrainz ID. Mute stops watching someone.

**Search** looks up a film, show or artist and adds it without leaving the app.
**Details** on a film or show opens the synopsis, cast, director, runtime and
genres in the card. That comes from Plex and needs no key. On the rare title
where Plex lists no cast, a TMDB key fills the actors in.

**Suggestions** are built from what you already own. Artists come from
ListenBrainz similar-artists, which needs no key. Films come from TMDB
recommendations, seeded from the films on your watchlist, and shows from TMDB's
television recommendations, seeded from the shows on your watchlist. Both need
the same free TMDB key as film dates. Building takes a few minutes.

Every suggestion carries a picture and a line or two about it. Films and shows
use the poster and synopsis TMDB already sends with a recommendation, so they
cost nothing extra. Artists are looked up one at a time in MusicBrainz, for
where they are from, when they started and what they are tagged as, and then
in Wikidata for a photograph. That is the slow part of a build, around two
seconds an artist, but the answers are kept for a month, so a second build is
quick.

Suggestions show this year onwards by default, because TMDB recommendations
lean heavily on catalogue. Tick **Include previous years** for the rest.

**Trending** is what is popular right now, rather than what is coming for
things you already follow. Films and shows come from TMDB's weekly trending
list and need the same free TMDB key as film dates and Suggestions; without
one they cannot be fetched at all. Country music comes from the US Apple
chart and needs no key, so the country charts work regardless. Albums are
shown by default; press Singles for the singles chart.

Each chart runs fifty deep, and the Catalogue tickbox hides anything released
more than a year ago. Shows are exempt from that rule, because the only date
the chart carries for a series is when it first aired, and a show can run for
a decade, so judging one by its premiere would file a series airing new
episodes this week alongside a record from 1973. Albums, singles and films
still follow the rule as normal. By default films and shows keep the full
fifty, and singles keep most of theirs, but the album chart is the one that
thins out: in a typical week only about two in five of the top fifty country
albums are less than a year old, the rest being records people have owned for
years. Tick Catalogue to see the whole chart. The rank on each row is fixed
once the chart is built and is never renumbered by hiding catalogue rows, so
hiding catalogue leaves gaps in the sequence, such as 1, 2, 3, 5, 6, 8, rather
than pretending the chart is shorter than it really is. For albums and
singles that rank is Apple's own chart position; for films and shows it is
our position after removing TMDB's duplicate entries, not TMDB's.

Building the chart takes a little over two minutes, most of it MusicBrainz
matching each country artist at its one-request-a-second limit.

## Cinema versus digital

Plex gives one date per film, which is normally the cinema release, not the day
you can watch it at home. So films are treated as cinema releases and hidden
behind the **Cinema** tickbox by default.

To separate the two, add a free TMDB API key under Settings. Plex already hands
the app a TMDB id for every watchlist film, so there is no title matching
involved. With a key, Out now lists films on their digital date and only genuine
cinema-only entries stay hidden.

Get a key at <https://www.themoviedb.org/settings/api>.

## Running a scan automatically

`run-scan.cmd` runs one music scan and exits, without opening the dashboard. To
have it run daily, point a Task Scheduler basic task at that file. The faster
Step 1 already runs on every start.

## Where things live

The database sits in `%LOCALAPPDATA%\PlexMediaTracker\plex-media-tracker.db`,
deliberately outside this OneDrive folder. OneDrive syncing a database file
while it is being written corrupts it.

To move it, set `PLEX_TRACKER_DATA_DIR`. For a different port, set
`PLEX_TRACKER_PORT`.

Dates are compared in Australia/Sydney, not UTC, so something released today
reads as released today rather than as upcoming until mid-morning. The page
pins the same zone, so "today", the date horizons and the catalogue cutoff
agree with the server even on a machine whose clock is set somewhere else.
Dates are written the Australian way, 22 September 2026, and the scan times in
Settings are Sydney times on the 24-hour clock.

## For developers

No runtime dependencies. Node 24 strips the TypeScript types itself and provides
the SQLite driver, HTTP server and fetch, so there is no build step.

```
npm start        # dashboard on port 7000
npm run scan     # one music scan, no dashboard
npm test         # unit tests
npm run typecheck
```

| File | Does |
| --- | --- |
| `src/server.ts` | HTTP server, static files, startup sync |
| `src/api.ts` | JSON endpoints and the unified feed |
| `src/scanner.ts` | The music scan and the quick refresh, with shared progress |
| `src/plex.ts` | The local Plex server |
| `src/plexdiscover.ts` | plex.tv: the watchlist, and adding and removing from it |
| `src/watchlist.ts` | Two-way watchlist sync and the library refresh |
| `src/watchlist-db.ts` | Watchlist storage and its feed |
| `src/episodes.ts` | Episode schedules for continuing shows |
| `src/tmdb.ts` | Cinema and digital film dates |
| `src/musicbrainz.ts` | MusicBrainz, including the rate limiter |
| `src/suggestions.ts` | ListenBrainz and Plex similar-item suggestions |
| `src/artistinfo.ts` | An artist's photograph and description, from MusicBrainz and Wikidata |
| `src/trending.ts` | The TMDB and Apple charts, matching them to Plex and MusicBrainz, and what gets stored |
| `src/youtube.ts` | Resolving a title to a YouTube video to embed |
| `src/details.ts` | Synopsis and cast behind a search result |
| `src/matching.ts` | Title and artist name normalisation |
| `src/dates.ts` | Sydney calendar dates |
| `src/db.ts` | Schema and the music queries |
| `public/feed.js` | Filtering, grouping and formatting, with no DOM |
| `public/app.js` | Rendering and events |

The designs are written up in `docs/specs/`.

The server binds to `127.0.0.1` only, so it is not reachable from other machines
on your network. Neither your Plex token nor your TMDB key is ever sent to the
browser. All artwork, including the Trending charts', is proxied through the
server too, so the browser never contacts Plex, Apple or TMDB directly.

## Known rough edges

The YouTube lookup reads the public search results page rather than using an
API, so it depends on YouTube's page shape. It now checks each result's title
before accepting it, and returns nothing rather than a wrong video, so a track
YouTube does not carry shows a search link instead of the artist's best known
song. The player names what it is playing, with a link to search if it is wrong.

Two of the 79 continuing shows fail their episode lookup on plex.tv and are
skipped.
