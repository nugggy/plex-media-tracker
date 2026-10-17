/**
 * The phone app's start-up. Loaded before public/app.js, it puts the fetch
 * bridge in place first, synchronously, so the dashboard's first calls go to
 * the NAS rather than to the app's own file server. The phone keeps no
 * library of its own: the NAS holds everything, and the phone keeps a copy of
 * the last answers for when the NAS cannot be reached.
 */
import { registerPlugin } from '@capacitor/core';
import { installFetchBridge, thumbLoader, withTimeout } from './bridge.ts';
import { browserCache, createClient, localStore, type ConnectionStatus } from './client.ts';
import { LATEST_RELEASE_API, githubProblem, pickUpdate, updateFromTag, type Update } from './updates.ts';
import { APP_VERSION } from '../src/version.ts';

interface UpdaterPlugin {
  canInstall(): Promise<{ allowed: boolean }>;
  openInstallSettings(): Promise<void>;
  downloadAndInstall(o: { url: string }): Promise<void>;
  latestTag(): Promise<{ tag: string }>;
}
const Updater = registerPlugin<UpdaterPlugin>('Updater');

interface LinksPlugin {
  openPlexSignIn(o: { url: string }): Promise<void>;
}
const Links = registerPlugin<LinksPlugin>('Links');

// Captured before the bridge replaces window.fetch. Long enough never to cut
// short a call that sets its own, shorter timeout.
const network = withTimeout(window.fetch.bind(window), 60_000);

const client = createClient({
  fetch: network,
  store: localStore(),
  cache: browserCache(),
  onStatus: (detail: ConnectionStatus) =>
    window.dispatchEvent(new CustomEvent('pmt:connection', { detail })),
});

installFetchBridge(window, (method, url, body, type) =>
  client.request(method, url.pathname + url.search, body, type),
);

// Coming back to the app may mean it has left home, so the public address is
// tried first again rather than a home address that will not answer.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') client.preferPublic();
});

(window as unknown as { pmtThumbLoader: (src: string) => Promise<string> }).pmtThumbLoader =
  thumbLoader(window.fetch);

/** What the page needs to set up and sign in to the server. */
(window as unknown as { pmtClient: unknown }).pmtClient = {
  serverUrl: () => client.serverUrl(),
  setServer: (raw: string) => client.setServer(raw),
  setLanUrl: (url: string | null) => client.setLanUrl(url),
  hasToken: () => client.hasToken(),
  setToken: (token: string | null) => client.setToken(token),
  openSignIn: (url: string) => Links.openPlexSignIn({ url }),
};

/**
 * The Settings page's Check for updates button. It asks GitHub for the latest
 * release; installing goes through the native plugin, which checks the file.
 */
(window as unknown as { pmtUpdater: unknown }).pmtUpdater = {
  async check(): Promise<{ update: Update | null; installed: string }> {
    // The releases page first: it has no hourly cap. The API is the fallback.
    try {
      const { tag } = await Updater.latestTag();
      return { update: updateFromTag(tag, APP_VERSION), installed: APP_VERSION };
    } catch {
      // Fall through to the API.
    }
    let r: Response;
    try {
      r = await window.fetch(LATEST_RELEASE_API, {
        headers: { Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new Error('Could not reach GitHub. Check your internet connection.');
    }
    if (r.status === 404) return { update: null, installed: APP_VERSION };
    if (!r.ok) throw new Error(githubProblem(r.status));
    return { update: pickUpdate(await r.json(), APP_VERSION), installed: APP_VERSION };
  },
  canInstall: () => Updater.canInstall(),
  openInstallSettings: () => Updater.openInstallSettings(),
  install: (url: string) => Updater.downloadAndInstall({ url }),
};
