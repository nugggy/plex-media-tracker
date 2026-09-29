/**
 * The shape of a quick refresh: which parts run, and in what order.
 *
 * Holdings talks to the home server. The other three talk to plex.tv, TVMaze
 * and TMDB, so there is no reason for them to queue behind it. Schedules and
 * film dates read the watchlist table, so they wait for the watchlist sync,
 * then run side by side.
 */
export type RefreshPart = 'holdings' | 'watchlist' | 'schedules' | 'filmdates';

export const ALL_PARTS: RefreshPart[] = ['holdings', 'watchlist', 'schedules', 'filmdates'];

export type RefreshSteps = Record<RefreshPart, () => Promise<void>>;

/**
 * Runs the wanted steps. A step's failure is the step's own business: each one
 * is expected to record its failure and resolve, but a throw is swallowed here
 * too so one part can never take the others down with it.
 */
export async function runRefreshPlan(steps: RefreshSteps, want: Set<RefreshPart>): Promise<void> {
  const run = (part: RefreshPart): Promise<void> =>
    want.has(part) ? steps[part]().catch(() => {}) : Promise.resolve();

  const server = run('holdings');
  const cloud = (async () => {
    await run('watchlist');
    await Promise.all([run('schedules'), run('filmdates')]);
  })();
  await Promise.all([server, cloud]);
}
