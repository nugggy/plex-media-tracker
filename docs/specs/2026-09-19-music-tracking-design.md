# Music tracking design

Date: 19/09/2026

## Purpose

Watch every artist in a local Plex music library and surface albums, EPs and
singles those artists have released recently or are about to release, that are
not already in the library.

## Decisions

- Runs locally on the user's Windows PC. No cloud component, no tunnelling, no
  credentials leaving the machine.
- Output is a local web dashboard only. No email, push or webhook alerts.
- Release types watched: Album, EP and Single. Anything carrying a MusicBrainz
  secondary type (Compilation, Live, Remix, Soundtrack, DJ-mix, Demo, Mixtape)
  is excluded by default, so reissues and live records do not flood the list.
- Every artist in the Plex music library is watched. Individual artists can be
  muted from the dashboard.
- Last.fm is not used.

## Constraints that shape the design

MusicBrainz permits roughly one request per second per client and requires a
descriptive User-Agent. This is the dominant cost. A first full scan of a
library takes about one second per artist plus one second per page of release
groups. A thousand-artist library is therefore a twenty to forty minute
background job, not a page load. Every subsequent scan only re-checks artists
whose data has gone stale.

SQLite must not live inside the OneDrive folder. OneDrive syncing a file that is
being written to produces corruption and conflict copies. The database lives in
`%LOCALAPPDATA%\WaxWrangler\`.

## Stack

Node 24 with no runtime dependencies. Node 24 strips TypeScript types natively,
and ships `node:sqlite`, `fetch` and `node:http`, so there is no build step, no
native compilation and no `node_modules` at runtime. TypeScript is a dev
dependency only, for `npm run typecheck`.

## Modules

`src/config.ts`
Resolves the data directory and port. Reads `WAX_WRANGLER_DATA_DIR` and
`WAX_WRANGLER_PORT` if set.

`src/db.ts`
Opens the SQLite database, applies the schema, exposes typed helpers for every
query the rest of the app needs. Nothing else writes SQL.

`src/plex.ts`
Talks to the Plex HTTP API over the LAN. Lists music sections, lists all artists
in a section, lists all albums in a section in one request. Extracts a
MusicBrainz artist ID from Plex GUID fields when the library agent provides one.

`src/musicbrainz.ts`
The only module that touches musicbrainz.org. Wraps every call in a serialised
queue that guarantees at most one request per second, sets a descriptive
User-Agent, and retries on 503 with backoff. Exposes artist search and release
group browse.

`src/matching.ts`
Title and name normalisation, and the artist disambiguation logic. Normalising a
title lowercases it, strips accents, removes bracketed suffixes such as
"(Deluxe Edition)" or "[Remastered]", and collapses punctuation and whitespace.

`src/scanner.ts`
The job. Runs one at a time, is resumable and reports live progress.
Phases:
1. Sync the Plex artist and album lists into the database.
2. Resolve a MusicBrainz ID for each artist that does not have one.
3. For each artist whose release data is stale, browse their release groups.
4. Classify each release group as owned, out now or upcoming.

`src/api.ts`
JSON endpoints consumed by the dashboard.

`src/server.ts`
Static file serving plus the API, on `http://localhost:7000`.

`src/scan-cli.ts`
Runs a scan from the command line without the server, for Task Scheduler.

`public/`
Dashboard: `index.html`, `app.js`, `styles.css`. No framework, no build.

## Artist identity

Getting the right MusicBrainz artist matters more than anything else, because a
wrong match silently watches the wrong discography.

1. If the Plex GUID carries a MusicBrainz ID, use it. This is exact.
2. Otherwise search MusicBrainz by name. Keep candidates scoring 85 or above
   whose normalised name equals the normalised Plex name.
3. One candidate: accept it.
4. Several candidates: fetch the release groups of the top three and pick the
   one sharing the most album titles with what Plex holds for that artist. If
   nothing overlaps, mark the artist ambiguous rather than guessing.
5. No candidates: mark not found.

Ambiguous and not-found artists appear in the dashboard so the user can paste a
MusicBrainz ID manually. A manual ID is never overwritten by a later scan.

## Classifying a release

For each release group returned for a watched artist:

- Skip it if the primary type is not Album, EP or Single.
- Skip it if it has any secondary type.
- Owned if its normalised title matches the normalised title of any album Plex
  holds for that artist.
- Upcoming if its first release date is after today.
- Out now if its first release date falls within the recent window, 180 days by
  default, and it is not owned.
- Otherwise it is old catalogue and is stored but not shown.

A release is flagged new the first time it is recorded. The user can dismiss a
release, which hides it permanently.

## Dashboard

Four views.

- Out now: released within the window, missing from the library, newest first.
- Coming soon: dated in the future, soonest first.
- Artists: everything watched, with resolution status, last checked time, a mute
  toggle and a field for a manual MusicBrainz ID. Ambiguous and failed artists
  sort to the top.
- Settings: Plex base URL and token with a test button, recent window length,
  staleness threshold, and release types to include.

A progress strip appears while a scan runs, showing phase, artists done and the
current artist.

## Error handling

Plex unreachable stops the scan immediately with a clear message, because
everything downstream depends on it. A MusicBrainz failure for one artist is
recorded against that artist and the scan continues, so one bad record cannot
halt the job. HTTP 503 from MusicBrainz backs off and retries three times before
being treated as a failure. Artists with errors are retried on the next scan.

## Out of scope

Notifications of any kind. Automatic downloading or requesting of releases.
Multiple users. Remote access. Anything touching the Plex server in write mode.
