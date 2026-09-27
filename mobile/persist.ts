/**
 * When to write the phone's database to storage. Quiet for five seconds is the
 * normal trigger, but a scan writes every second for half an hour, so a save
 * also happens once thirty seconds of unsaved work have built up. Never in the
 * middle of a transaction, never two at once, and a failed save is tried again
 * rather than forgotten.
 */
export function createSaver(opts: {
  save: () => Promise<void>;
  inTransaction: () => boolean;
  quietMs?: number;
  maxWaitMs?: number;
  retryMs?: number;
}): { markDirty(): void; flush(): Promise<void> } {
  const quiet = opts.quietMs ?? 5_000;
  const maxWait = opts.maxWaitMs ?? 30_000;
  const retry = opts.retryMs ?? 5_000;
  let dirtySince: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let saving: Promise<void> | null = null;

  function schedule(delay: number): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void run(), delay);
  }

  async function run(): Promise<void> {
    timer = null;
    // Wait out a save already under way; whoever wakes first starts the next.
    while (saving) await saving.catch(() => {});
    if (dirtySince === null) return;
    if (opts.inTransaction()) {
      schedule(250);
      return;
    }
    const since = dirtySince;
    dirtySince = null;
    saving = opts.save();
    try {
      await saving;
    } catch {
      // Keep the unsaved changes marked, keeping the original age so the
      // thirty-second cap still counts from the first unsaved write.
      dirtySince = dirtySince === null ? since : Math.min(dirtySince, since);
      schedule(retry);
    } finally {
      saving = null;
    }
  }

  return {
    markDirty() {
      const now = Date.now();
      dirtySince ??= now;
      const delay = Math.max(0, Math.min(quiet, maxWait - (now - dirtySince)));
      schedule(delay);
    },
    async flush() {
      if (timer) clearTimeout(timer);
      timer = null;
      await run();
    },
  };
}
