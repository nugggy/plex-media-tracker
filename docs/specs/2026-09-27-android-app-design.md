# Android app design

Date: 27/09/2026

Runs the tracker on an Android phone, entirely on the device. No server, nothing
hosted elsewhere. The phone keeps its own database and does its own scans; the
PC version carries on unchanged and the two never share data.

## What was verified before designing

The backend cannot move to the phone as it is. It is a Node 24 server that uses
`node:sqlite` and `node:http`, and runs TypeScript directly. Embeddable Node for
Android stops at Node 18, which has neither `node:sqlite` nor type stripping.
The Node-only imports are confined to `src/server.ts`, `src/api.ts`,
`src/db.ts` and `src/config.ts`. Everything else talks to the network with
`fetch` and to the database through `db.prepare` / `db.exec`, about 120 call
sites across 11 files, all synchronous.

Remote access works. Plex reports the server as fully accessible outside the
network, public address 1.156.62.8:20972. The automatic lookup added on
27/09/2026 (`src/plexconnect.ts`) finds the server on plex.tv and picked the
secure LAN address from the PC. The public address did not answer from inside
the house, which is expected: most home routers do not loop a request back to
their own public address. It gets its real test from the phone on mobile data.

The build machine has the Android SDK (platform 36, build tools 36.1.0).
Capacitor 8 needs JDK 21, so the build uses the JDK 21 that ships with Android
Studio, at `C:\Program Files\Android\Android Studio\jbr`, rather than the
OpenJDK 17 also installed. `java` on the PATH is an old Java 8, so the build
sets `JAVA_HOME` itself. There is no
`gh` CLI; Git Credential Manager is configured.

The phone is a OnePlus 15. OxygenOS is among the harshest Android skins for
background work, which shapes the scanning design below.

## Shape

A Capacitor app in `android/`, wrapping the existing dashboard in `public/`.
The backend modules run inside the app's web view. One codebase serves both the
PC and the phone. Two seams make that possible.

### Seam 1: routing without Node's HTTP server

`handleApi(req, res, url)` becomes a thin Node adapter over a transport-free
router:

```ts
route(method: string, url: URL, body: Record<string, unknown>): Promise<ApiResponse>
// ApiResponse = { status, json } | { status, bytes, contentType }
```

`src/server.ts` keeps reading the request, calling `route`, and writing the
response. On the phone, `mobile/bridge.ts` wraps `window.fetch` so that any
request for `/api/...` calls `route` directly and answers with a `Response`.
`public/app.js` does not change how it calls the API.

### Seam 2: the database behind an interface

`src/sqlite.ts` defines the small surface the code already uses:

```ts
interface Db {
  exec(sql: string): void;
  prepare(sql: string): { get(...p): unknown; all(...p): unknown[]; run(...p): unknown };
}
```

The PC implementation is `node:sqlite` as now. The phone implementation is
sql.js, SQLite compiled to WebAssembly, which is synchronous and so fits every
existing call site unchanged. The phone's database lives in memory and is
exported to the app's private storage through the Capacitor Filesystem plugin
five seconds after the last write, and immediately when the app goes to the
background. On start it is loaded from that file. `src/db.ts` and the other
modules import the database from one place, which picks the implementation at
start-up.

`src/config.ts` keeps its Node paths for the PC; the phone build swaps in a
mobile config with no filesystem paths.

### Bundling

The PC keeps running `.ts` directly. The phone build uses esbuild to bundle the
backend and `mobile/bridge.ts` into one browser script loaded by
`public/index.html` before `app.js`. The sql.js WebAssembly file ships as an
asset in the APK.

## Network calls

Capacitor's native HTTP layer (`CapacitorHttp`, enabled in
`capacitor.config.ts`) patches `fetch` so every outbound call is made natively.
That removes browser cross-origin blocks for Plex, plex.tv, MusicBrainz,
TVmaze, TMDB and the rest, and lets MusicBrainz see the User-Agent it requires.

Timeouts: the code uses `AbortSignal.timeout` throughout. If the native layer
ignores the signal, the bridge wraps each call in its own timer that rejects
with a `TimeoutError`, so existing error handling keeps working.

Images: `<img src="/thumb?...">` does not go through `fetch`, so the bridge
watches for images with a `/thumb` source, fetches them through `route`, and
swaps in a blob URL.

## Plex connection on the phone

Automatic mode is the default on the phone. A LAN address typed on the phone is
useless away from home. Settings on the phone keeps the manual option for
completeness, with the same wording as the PC.

## Background scanning

The MusicBrainz step takes 20 to 40 minutes on a first run, one request a
second. It must keep going with the screen off and the app in the background.

The first route to try: a native Kotlin foreground service, `ScanService`,
type `dataSync`, with an ongoing notification and a partial wake lock. A small
Capacitor plugin, `ScanKeeper`, starts it when a scan starts and stops it when
the scan ends, and updates the notification text with progress. The scan
itself keeps running as JavaScript in the web view, which the service keeps
alive. The app asks once to be excluded from battery optimisation.

This route is proven before anything else is built on it. A test APK runs a
one-request-a-second loop against MusicBrainz under the foreground service and
shows the expected count against the actual count. It passes if, after 10
minutes with the screen off and battery use set to Unrestricted, the actual
count is at least 90 percent of the expected one.

If it fails, the fallback is to move the MusicBrainz identify-and-releases loop
into Kotlin inside the service, writing to the same SQLite file. That is
decided on the test result, before the rest of the port starts.

## Build and delivery

A private GitHub repository, `plex-media-tracker`, created through Chrome and
pushed with the existing Git Credential Manager. Before the first push, the
uncommitted work already in the tree (air times, then remote access) is
committed as separate commits.

A GitHub Actions workflow, `.github/workflows/android.yml`, runs on a `v*` tag.
It sets up JDK 21 and Node 24, runs the tests, bundles, syncs Capacitor, and
builds a signed release APK with Gradle. It publishes a GitHub release with the
APK attached as `plex-media-tracker-<version>.apk`.

Signing: one release keystore, generated once. It is stored as repository
secrets (the keystore base64-encoded, plus its passwords) and backed up to the
data folder `%LOCALAPPDATA%\PlexMediaTracker\android-release.jks`, outside the
repo. `*.jks` and `*.keystore` join `.gitignore`. Every build must use the same
key or Android refuses to install it as an update.

The first APK is also built locally, into `dist/plex-media-tracker-<version>.apk`
(`dist/` is ignored), so there is no wait on the workflow. The app version moves
to 1.2.0.

Download links: the PC Settings page gets a "Get the Android app" link, and the
phone's Settings page a "Check for a newer version" link. Both point at
`https://github.com/<owner>/plex-media-tracker/releases/latest`. The repository
is private, so the phone must be signed in to GitHub to download. The phone
Settings page also shows the installed version.

## Testing

The existing tests keep running against the PC code path.

New tests: `route` returns the same results as `handleApi` did for a
representative set of endpoints; the sql.js adapter passes the same get, all,
run and exec behaviour as the `node:sqlite` one; the database is saved after a
write and loads back identically; the fetch bridge answers `/api` calls and
passes everything else through.

Size check: a copy of the real database loads into sql.js and the export time
is measured, before relying on the save-after-write approach.

On the phone: the background test above, then a full check over mobile data
(Wi-Fi off) that the app finds the server at its public address, reads the
library, syncs the watchlist, and completes a scan with the screen off.

## Out of scope

Sharing data between the PC and the phone. Play Store publishing. iOS. Signing
in with a Plex PIN instead of pasting a token.
