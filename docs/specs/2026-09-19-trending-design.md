# Trending design

Date: 19/09/2026

Adds a Trending tab showing what is popular right now in films, television and
country music, with a trailer or a play button on every row, and a one-press
path onto the Plex watchlist or the watched artist list.

The app so far answers "what is coming for the things I already follow".
Trending answers the opposite question, "what is everyone else watching and
listening to that I do not follow yet". Suggestions sits between the two and is
built only from what is already owned, so it never surfaces something with no
connection to the existing library.

## What was verified before designing

Every source below was called for real before it was chosen.

The Apple iTunes RSS chart still serves per-region, per-genre charts with no API
key. `https://itunes.apple.com/us/rss/topalbums/limit=50/genre=6/json` returns
the US country album chart, and `topsongs` the singles chart, both with artist,
title, release date, artwork and a stable Apple id. Genre 6 is Country.

ListenBrainz fresh releases was tested and rejected. A thirty day window returns
9,319 releases of which five carry any country-related tag, and every listen
count is zero. MusicBrainz genre tagging is far too sparse to build a country
chart from, and the endpoint is a new-release firehose rather than a chart.

Last.fm would serve genre charts but the music tracking design records that
Last.fm is not used, and that decision stands.

The Plex Discover trending hubs were not tested, because reading the stored Plex
token was blocked. TMDB was chosen instead. It is documented, stable, and the
app already carries an optional TMDB key for separating cinema and digital
dates.

Of the US top fifty country albums, thirty were released more than twelve months
ago. That number is what drives the catalogue rule below. A handful of chart
entries carry no release date at all.

## Decisions

- Films and shows come from TMDB weekly trending. Country music comes from the
  Apple iTunes RSS chart. No new API key beyond the TMDB one the app already
  offers.
- The country chart is the United States chart. It is the chart the genre's
  press follows, and it leads the Australian one.
- Each chart runs fifty deep.
- Albums are the focus. Singles are a chip that is off by default.
- Catalogue, meaning anything released more than twelve months ago, is hidden
  behind a tickbox. It is not dropped, because it really is charting.
- Nothing here writes to Plex on its own. Adding is always a deliberate press.

## Where each list comes from

| Chip | Source | Request |
| --- | --- | --- |
| Films | TMDB | `/3/trending/movie/week` |
| Shows | TMDB | `/3/trending/tv/week` |
| Albums | Apple | `/us/rss/topalbums/limit=50/genre=6/json` |
| Singles | Apple | `/us/rss/topsongs/limit=50/genre=6/json` |

TMDB pages twenty at a time, so fifty takes three requests per type and the
third page is trimmed. Apple serves fifty in one. The whole build is eight
requests to two hosts, so the network cost is trivial. The slow part is
resolution, described next.

Without a TMDB key the Films and Shows chips are disabled and say why, pointing
at Settings. The music chips keep working, because Apple needs no key. This
mirrors how the app already degrades when no key is set.

## Making a chart row actionable

A chart row is a name and a picture. Acting on it needs an identifier the rest
of the app understands, and that resolution is the only real work in the
feature.

**A film or show** needs a Plex Discover rating key before it can go on the
watchlist. TMDB does not give one. The build resolves each title through the
Discover search that `src/search.ts` already uses, matching on title and year,
and stores the mapping. Resolving during the build rather than on the click is
deliberate: it lets the card show the green tick when the thing is already on
the watchlist, and hide the Add button entirely when Plex has no match, so no
button is ever offered that cannot work.

**An album or single** has no Plex equivalent, because Plex has no music
watchlist. The action is Watch artist, the same one the Suggestions tab offers.
The build resolves the chart's artist name to a MusicBrainz ID through the
existing `searchArtist`, and the artist is then tracked exactly as a manually
added artist is today, with a `manual:` key and no claim of ownership.

MusicBrainz permits one request per second, so resolution is the cost of the
feature. Fifty albums and fifty singles is a hundred artists, but the chart
repeats artists heavily and the mapping is cached by folded artist name, so a
first build is roughly a minute and later builds are seconds. The cache is
shared between the album and singles charts.

A row whose artist cannot be resolved still appears. It keeps its play button
and its Apple link, and simply offers no Watch artist button.

## The catalogue rule

A row is catalogue when its release date is more than twelve months before
today, compared in Australia/Sydney like every other date in the app. Catalogue
rows are hidden unless the Catalogue tickbox is on, matching the shape of the
existing Cinema tickbox.

A row with no release date is never treated as catalogue. Apple omits the date
on some very new singles, and hiding a brand new release because its date was
missing is the worse error of the two.

The chart position is kept and shown on every row, so hiding catalogue leaves
visible gaps in the numbering rather than pretending the chart is shorter than
it is.

## Already have it

The same two ticks the rest of the app uses apply here.

A film or show already on the watchlist shows "On watchlist" instead of an Add
button. One already sitting on the Plex server carries the green In Plex tick,
read from `library_guids` through the resolved Discover GUID, exactly as search
results do.

An artist already watched shows "Watched". An album or single is marked as
owned when that exact record is already in the Plex music library: the chart
row's resolved mbid belongs to a real Plex artist, meaning a `plex_key` that
does not start with `manual:`, and that artist owns an album whose normalised
title matches the chart row's own.

This is deliberately album level, not artist level as an earlier draft of this
section said. Everywhere else on this page `in_library` means this exact thing
is on the server: a film tick means this film, a show tick means this show. An
album row ticking because the artist happens to have other records, while the
charting album itself is missing, would make one tick on the page mean
something different from every other tick on it, which is a worse outcome than
the gap it would fill. A row with no resolved mbid, or an artist watched only
manually with no real records, is never marked owned.

Singles rarely tick, and that is correct rather than a shortcoming. A single is
usually a track off an album, not an album in its own right, so the album-level
check above will not find a matching record for most of them. Loosening the
match to make singles tick more often would mean guessing at whether the track
appears on some album, which is exactly the kind of confident-looking wrong
answer this feature is built to avoid.

## Trailers and playback

No new code. `/api/youtube` already takes a kind, a title and a subtitle, and
`src/youtube.ts` already scores `trailer` and `teaser` upwards for kinds `movie`
and `show`, and artist plus track for music. Trending calls it with kind
`movie`, `show` or `single` and the existing `togglePlayer` renders the inline
frame, closing any other open player as it does today.

The existing rule that an unverified match returns nothing rather than a wrong
video applies unchanged, so a row with no confident match shows a search link.

## Artwork

Apple artwork tops out at 170 pixels and carries no token. TMDB posters likewise
need no token. Neither therefore needs proxying to protect a secret.

They are proxied anyway, through a new `url` mode on the existing `/thumb`
endpoint, so the page never issues requests to third-party hosts. That mode
accepts only URLs whose host is on a fixed allowlist of the Apple and TMDB image
hosts. An unrestricted proxy would be a server-side request forgery hole, and
the allowlist is what prevents it. Anything off the list returns 404.

## Freshness

Charts move weekly at most. The stored list carries a built-at timestamp and is
considered fresh for twenty-four hours.

Building is manual, from a Build button on the tab, in the same shape as
Suggestions: a POST that starts the work, a progress endpoint the page polls,
and a message when it finishes. It is deliberately not part of Check for
updates. That button is about the user's own library and watchlist, and adding a
minute of MusicBrainz lookups for a chart nobody asked to see would slow the
thing people press most.

If the tab is opened with no stored list, it says so and offers the button. If
the stored list is older than a day, it shows it with a note saying when it was
built.

## Modules

`src/trending.ts`
All four sources, the resolution steps, the cache table and the build. The only
module that knows the Apple RSS shape or the TMDB trending shape.

`src/tmdb.ts` gains the two trending calls. It already owns the TMDB host and
the key, and nothing else should learn either.

`src/search.ts` gains an exported single-title Discover lookup, factored out of
the existing `discoverSearch`, so trending can resolve one title without
duplicating the endpoint shape. `src/plexdiscover.ts` stays the only module
knowing the watchlist endpoints.

`src/api.ts` gains `/api/trending`, `/api/trending/build`, `/api/trending/progress`
and `/api/trending/hide`, and the `url` mode on `/thumb`.

`public/app.js` gains the tab, following the suggestions block almost exactly.
The card, the chips, the hide action and the add action are all existing
patterns.

## Storage

One table, rebuilt wholesale on each build, plus one long-lived cache.

```
trending_items
  kind        movie | show | album | single
  id          TMDB id, or the Apple collection id
  rank        chart position, 1 based
  title
  subtitle    artist for music, the empty string otherwise
  year
  release_date
  thumb       the source artwork URL
  link        the TMDB or Apple page
  rating_key  resolved Plex Discover key, null when unresolved
  guid        resolved Plex GUID, for the in-library check
  mbid        resolved MusicBrainz artist ID, null when unresolved
  built_at
```

```
trending_hidden
  kind        part of the primary key
  id          part of the primary key
  hidden_at
```

```
artist_mbid_cache
  name_folded  primary key
  mbid         null when the lookup found nothing
  looked_up
```

Hiding lives in its own table rather than a column, because `trending_items` is
emptied and rewritten on every build and a column would be wiped with it. The
feed joins the two, so Not for me survives pressing Build. The artist cache is
kept for a fortnight, matching the YouTube cache.

## Testing

`tests/trending.test.ts` covers the parts worth testing, which are the pure
ones, with no network in any test.

- Parsing an Apple chart payload into rows, including the album link being an
  object where the song link is an array.
- The catalogue rule: old is catalogue, recent is not, missing date is not.
- Chart rank is preserved through filtering.
- Title and year matching when picking a Discover result for a TMDB film.
- Artist name folding, so "Morgan Wallen" and "morgan wallen" share one cache
  entry.

The network calls themselves are checked by hand against the live services, as
the existing modules are.

## Out of scope

- Genres other than country. Genre 6 is fixed. A genre picker is a later
  decision, not this one.
- Any chart the app would have to pay for or hold a further key for.
- Automatic adding. Nothing reaches the Plex account without a press.
- Trending music beyond albums and singles. Apple's chart has no EP list, and
  EPs appear in the album chart anyway.
- Notifications of any kind, consistent with the rest of the app.
