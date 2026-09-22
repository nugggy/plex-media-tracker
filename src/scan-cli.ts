/**
 * Runs one scan and exits. Intended for Windows Task Scheduler, so the library
 * stays current without the dashboard being open.
 */
import { runScan, getProgress } from './scanner.ts';
import { isConfigured } from './db.ts';

if (!isConfigured()) {
  process.stderr.write(
    'Plex Media Tracker is not configured yet. Start the dashboard with "npm start" and add your Plex details first.\n',
  );
  process.exit(1);
}

const timer = setInterval(() => {
  const p = getProgress();
  if (!p.running) return;
  const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
  process.stdout.write(`[${p.phase}] ${p.done}/${p.total} (${pct}%) ${p.current}\n`);
}, 15_000);
timer.unref();

const result = await runScan();
clearInterval(timer);

process.stdout.write(`${result.message}\n`);
process.exit(result.phase === 'failed' ? 1 : 0);
