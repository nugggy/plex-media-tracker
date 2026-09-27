/**
 * The phone app's start-up. Loaded before public/app.js, it puts the fetch
 * bridge in place first, synchronously, so the dashboard's first calls wait
 * for the backend instead of going to the network. The backend itself loads
 * only once the database is open, because src/db.ts opens it on import.
 */
import { registerPlugin } from '@capacitor/core';
import { installFetchBridge, thumbLoader } from './bridge.ts';
import { initMobileDatabase, flushDatabase } from './sqlite-driver.ts';

interface ScanKeeperPlugin {
  start(o: { title: string; text: string }): Promise<void>;
  update(o: { text: string }): Promise<void>;
  stop(): Promise<void>;
  requestBatteryExemption(): Promise<{ granted: boolean }>;
}
const ScanKeeper = registerPlugin<ScanKeeperPlugin>('ScanKeeper');

function askOnceForBatteryExemption(): void {
  try {
    if (localStorage.getItem('asked-battery') === '1') return;
    localStorage.setItem('asked-battery', '1');
  } catch {
    // Without storage we would ask every time, so do not ask at all.
    return;
  }
  void ScanKeeper.requestBatteryExemption();
}

const backend = initMobileDatabase().then(async () => {
  const [{ route }, { startBackgroundSync }, scanner] = await Promise.all([
    import('../src/route.ts'),
    import('../src/startup.ts'),
    import('../src/scanner.ts'),
  ]);

  let poll: ReturnType<typeof setInterval> | null = null;
  scanner.scanHooks.onStart = () => {
    // If Android will not start the service, the check still runs, only
    // without protection from being paused while the app is off screen.
    ScanKeeper.start({ title: 'Plex Media Tracker', text: 'Checking for updates' }).catch((err) =>
      console.warn('Background service not started:', err),
    );
    askOnceForBatteryExemption();
    poll = setInterval(() => {
      const p = scanner.getProgress();
      ScanKeeper.update({ text: p.current || p.message || 'Checking for updates' }).catch(() => {});
    }, 5000);
  };
  scanner.scanHooks.onEnd = () => {
    if (poll) clearInterval(poll);
    poll = null;
    void flushDatabase();
    ScanKeeper.stop().catch(() => {});
  };

  startBackgroundSync();
  return route;
});

// Long enough never to cut short a call that sets its own, shorter timeout.
installFetchBridge(window, async (method, url, body) => (await backend)(method, url, body), {
  timeoutMs: 90_000,
});
(window as unknown as { pmtThumbLoader: (src: string) => Promise<string> }).pmtThumbLoader =
  thumbLoader(window.fetch);
