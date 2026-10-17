# Running Plex Media Tracker on the NAS

The app runs in Container Station on the QNAP, next to Plex. It holds the only
copy of the library. The dashboard opens in any browser, and the Android app
shows the same data from anywhere. Everyone signs in with the Plex account that
owns the Plex server, and nobody else can get in.

Two containers run together:

- **plex-media-tracker** is the app. It answers on port 7000, for the home
  network only.
- **plex-media-tracker-https** is Caddy. It gives the app a proper HTTPS
  certificate and is the only thing the modem lets in from outside.

## What you need

- A public name for your home connection. This NAS uses its myQNAPcloud name,
  `nuggy.myqnapcloud.com`, which already points at the static IP. Another option is `yourname.duckdns.org`. Your
  Telstra static IP never changes, so the name only has to be set once. DuckDNS
  is free: sign in at <https://www.duckdns.org>, add a subdomain, and set its
  address to your static IP. A domain you already own works just as well, with
  an A record pointing at the static IP.
- Outside port 443 free on the modem. Nothing else at home can be using it.

## 1. Forward one port on the Telstra modem

In the Smart Modem's settings (usually <http://192.168.0.1>), go to Advanced,
then Port Forwarding, and add a rule:

| Setting | Value |
| --- | --- |
| Protocol | TCP |
| External port | 443 |
| Internal IP | 192.168.0.162 |
| Internal port | 7443 |

Forward nothing else. In particular, do not forward 7000 (the app without
HTTPS), 8080 or 443 to the NAS's own admin pages. QNAP's admin interface has a
history of being attacked when it is open to the internet. While you are in
the QNAP settings, check that UPnP port forwarding is off under myQNAPcloud,
then Auto Router Configuration.

## 2. Make the folders on the NAS

In File Station, inside the `Container` shared folder, make a folder called
`plex-media-tracker`, with two folders inside it called `data` and `caddy`.
Copy `deploy/Caddyfile` from this repository into `plex-media-tracker`.

## 3. Bring your library across

Close the app on the PC first, so the database is not being written. Then copy
`plex-media-tracker.db` from `%LOCALAPPDATA%\PlexMediaTracker` into
`Container\plex-media-tracker\data` on the NAS. If files ending in `-wal` and
`-shm` sit beside it, copy those too.

## 4. Start it in Container Station

Open Container Station, choose Applications, then Create. Name it
`plex-media-tracker`, and paste in the contents of `deploy/docker-compose.yml`.
Change `CHANGE-ME.duckdns.org` near the top to your public name, then press
Create.

The first start pulls both images and Caddy fetches its certificate, which
takes a minute or two. Caddy's log in Container Station says when the
certificate is in place.

## 5. Sign in

On a computer at home, open <http://192.168.0.162:7000> and press Sign in with
Plex. Approve it in the Plex window that opens. From outside the home, use
`https://yourname.duckdns.org` instead.

## 6. The phone

Install version 2.0.1 or later of the Android app. It asks for the server
address. Enter `https://yourname.duckdns.org`, press Sign in with Plex, approve
it in the browser that opens, and come back to the app.

On the home Wi-Fi the public address reaches the modem's own login page instead
of the NAS, because the modem does not loop it back inside. So fill in Address
at home as well: `http://192.168.0.162:7000`. The app tries the public address
first, sees it is not the server, and uses the home one. It only sends its
sign-in there once the NAS has proved it is yours. Both can be changed later in
Settings, then Account.

The phone stays signed in.

When the NAS cannot be reached at all, the app shows the lists and pictures it
last loaded, with a note at the top saying when they were saved.

Only approve a Plex sign-in that you started yourself, in this app. Someone
could send you a genuine Plex approval link for a sign-in they started, and
approving it would let them in. Settings, then Account, lists everything signed
in, with a button to sign out any one you do not recognise.

## Updating

Each release builds a new image. In Container Station, open the
`plex-media-tracker` application and choose to recreate it, or pull the
`latest` image again and restart the container. The database lives in the
`data` folder, so nothing is lost.

## What runs by itself

- The quick refresh (Plex library, watchlist, episodes and film dates) when the
  last one is more than two hours old, checked every 15 minutes.
- The full check, including MusicBrainz, once a night in the 3 am hour, Sydney
  time.

## If something goes wrong

- **The phone says it cannot reach the server.** Check the modem rule, and that
  `https://yourname.duckdns.org` opens in the phone's browser.
- **Caddy cannot get a certificate.** Let's Encrypt has to reach outside port
  443. Check the modem rule, and that the public name points at your static IP.
- **Saving lyrics to Plex fails.** The music share has to be mounted
  read-write. The compose file mounts `Nuggy NAS Shared Folder`. Music kept in
  any other shared folder needs its own line under `volumes`.
- **Locked out.** Any session can be ended from Settings, then Account, either
  one at a time or with Sign out everywhere. If no device is signed in, open the home address on a
  computer at home and sign in again.
