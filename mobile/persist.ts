/**
 * When to write the phone's database to storage. Quiet for five seconds is the
 * normal trigger, but a scan writes every second for half an hour, so a save
 * also happens once thirty seconds of unsaved work have built up. Never in the
 * middle of a transaction.
 */
export function createSaver(opts: {
  save: () => Promise<void>;
  inTransaction: () => boolean;
  quietMs?: number;
  maxWaitMs?: number;
}): { markDirty(): void; flush(): Promise<void> } {
  const quiet = opts.quietMs ?? 5_000;
  const maxWait = opts.maxWaitMs ?? 30_000;
  let dirtySince: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let saving: Promise<void> | null = null;

  async function run(): Promise<void> {
    timer = null;
    if (dirtySince === null) return;
    if (opts.inTransaction()) {
      timer = setTimeout(run, 250);
      return;
    }
    if (saving) await saving;
    dirtySince = null;
    saving = opts.save().finally(() => (saving = null));
    await saving;
  }

  return {
    markDirty() {
      const now = Date.now();
      dirtySince ??= now;
      if (timer) clearTimeout(timer);
      const delay = Math.max(0, Math.min(quiet, maxWait - (now - dirtySince)));
      timer = setTimeout(run, delay);
    },
    async flush() {
      if (timer) clearTimeout(timer);
      await run();
    },
  };
}
