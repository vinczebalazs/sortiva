/**
 * Where the two rate-based brakes get their numbers.
 *
 * The spend caps read `spend_events`, a table that exists and is written on
 * every paid call. The quality brake reads `gate_decisions`, which holds every
 * verdict the quality gate reaches. The publishing brake reads
 * `publish_attempts`, which holds one row per request to a merchant's shop and
 * how it ended.
 *
 * All three counters are built by the sweep out of the database handle it is
 * already given, so there is no wiring step anyone can forget — which is how
 * both of these brakes spent their first months connected to nothing.
 *
 * The publishing one could not exist until `publish_attempts` did. Publishing
 * goes through `publish_intents`, whose claim row is *deleted* when a shop
 * refuses a post, because the claim's name has to be free for the next attempt
 * — so the ordinary failure, and the exact shape of the platform outage this
 * brake is for, left nothing behind. A rate computed from what survived there
 * would have reported a healthy zero right through the outage it was meant to
 * catch.
 */

/** A count of failures against a count of attempts, over whatever window the caller asked for. */
export interface FailureCount {
  failures: number
  sample: number
  /**
   * False when nothing recorded these outcomes, so the caller can tell "nothing
   * went wrong" from "nobody is writing it down". A brake must never read the
   * second as the first.
   */
  measurable: boolean
}

/** How many of the last `n` drafts the quality judge rejected. */
export interface JudgeOutcomeCounter {
  recentJudgeOutcomes(trailingDrafts: number): Promise<FailureCount>
}

/** How many publish attempts failed inside the window. */
export interface PublishOutcomeCounter {
  recentPublishOutcomes(windowHours: number): Promise<FailureCount>
}
