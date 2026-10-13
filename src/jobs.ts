/**
 * A background job the page starts and then polls: lyrics, suggestions and
 * trending each have one. One at a time per kind, with a single line of
 * progress, and `ok` false when it ended badly so the banner can turn red.
 * Polled every second or so, so reading it does no database work.
 */
export interface JobProgress {
  running: boolean;
  message: string;
  ok: boolean;
}

export interface Job {
  progress(): JobProgress;
  /** Throws when one is already running, so two can never overlap. */
  begin(message: string, busy?: string): void;
  say(message: string): void;
  end(message: string, ok: boolean): void;
}

export function createJob(): Job {
  const state: JobProgress = { running: false, message: '', ok: true };
  return {
    progress: () => ({ ...state }),
    begin(message, busy = 'That job is already running.') {
      if (state.running) throw new Error(busy);
      Object.assign(state, { running: true, message, ok: true });
    },
    say(message) {
      state.message = message;
    },
    end(message, ok) {
      Object.assign(state, { running: false, message, ok });
    },
  };
}

/**
 * Starts `work` without waiting for it, keeping the job's progress current and
 * catching any failure, since nothing awaits the promise and an unhandled
 * rejection would otherwise escape.
 */
export function runInBackground(
  job: Job,
  work: (say: (m: string) => void) => Promise<{ message: string }>,
): void {
  job.begin('Starting');
  void work((m) => job.say(m))
    .then((r) => job.end(r.message, true))
    .catch((e: Error) => job.end(`Failed: ${e.message}`, false));
}
