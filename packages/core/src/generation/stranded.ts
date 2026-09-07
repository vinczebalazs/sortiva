/**
 * A day's writing that was interrupted and never came back.
 *
 * The daily cycle picks up an unfinished run only while it is still the same
 * day on the store's own clock. A worker killed at 23:50 and restarted at 00:05
 * therefore finds nothing: the run it was retrying belongs to a date the new
 * day never asks about. The article was written, nothing graded it, and the
 * retry reports success.
 *
 * This is the part of the recovery that needs no database: given the runs left
 * behind, decide which one to finish and which to give up on. One is finished
 * because the money is already spent on it; the others are given up on rather
 * than finished, because finishing every one of them would put several days'
 * articles into one day — the burst the calendar's keep-the-gap rule exists to
 * prevent.
 */

/** One interrupted run, with just enough about it to say how far it got. */
export interface StrandedRun {
  readonly topicId: string
  /** The calendar date the run's article belongs to. `YYYY-MM-DD`. */
  readonly scheduledDate: string
  /** The article row a previous attempt left behind, if it got that far. */
  readonly articleId: string | null
  /** Whether the writer's own output was stored before the kill — the expensive half. */
  readonly hasStoredDraft: boolean
}

export interface StrandedTriage {
  /** The one to finish, or nothing when there is nothing stranded. */
  readonly finish: StrandedRun | undefined
  /** Everything else: given up on, loudly. */
  readonly abandon: readonly StrandedRun[]
}

/**
 * How much of the money a run already cost is still recoverable.
 *
 * The writer's call is by far the most expensive step in the pipeline and its
 * output is stored before anything grades it, so a run that got that far can be
 * finished for the price of the checks alone. A run that only reached its
 * article row has paid for the evidence pack; one with nothing at all has paid
 * for nothing and would be written from scratch.
 */
export function strandedProgress(run: StrandedRun): number {
  if (run.hasStoredDraft) return 2
  if (run.articleId !== null) return 1
  return 0
}

/**
 * Which one is finished, and which are abandoned.
 *
 * Furthest along wins, because it is the one whose abandonment would throw away
 * the most already-paid-for work. Where two are equally far along the more
 * recent day wins: a run stranded three weeks ago was written against search
 * results and a catalogue that have since moved, and finishing it would grade a
 * draft against evidence that no longer describes the store.
 */
export function triageStrandedRuns(runs: readonly StrandedRun[]): StrandedTriage {
  const ranked = [...runs].sort((a, b) => {
    const byProgress = strandedProgress(b) - strandedProgress(a)
    return byProgress !== 0 ? byProgress : b.scheduledDate.localeCompare(a.scheduledDate)
  })
  const [finish, ...abandon] = ranked
  return { finish, abandon }
}
