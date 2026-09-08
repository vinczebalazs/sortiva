/**
 * Where the two rate-based brakes get their numbers.
 *
 * The spend caps read `spend_events`, a table that exists and is written on
 * every paid call. The quality brake reads `gate_decisions`, which holds every
 * verdict the quality gate reaches; the sweep builds that counter itself out of
 * the database handle it is already given, so there is no wiring step anyone can
 * forget — which is how this brake spent its first months connected to nothing.
 *
 * **The publishing brake still cannot see, and this is the reason.** Publishing
 * goes through `publish_intents`, a table that has existed for some time — but
 * having the table is not the same as recording the number. A claim is written
 * before a post is sent and has three ends: it is confirmed when the shop takes
 * the post, it is abandoned when we finally give up on it, and — when the shop
 * *refuses* it, which is the ordinary way a publish fails and the exact shape of
 * the platform outage this brake exists for — the row is deleted outright,
 * because the claim's name has to be free for the next attempt. So the commonest
 * failure leaves nothing behind at all, and a rate computed from what remains
 * would report a healthy zero right through the outage it is meant to catch.
 *
 * Rather than build that, the seam keeps a stand-in that says out loud that it
 * knows nothing. It registers in the repo's stub registry, so `pnpm
 * stubs:report` lists it and the milestone gate that turns on `--fail-if-any`
 * fails while it is still wired. Closing it needs a durable record of a publish
 * attempt and how it ended, which is a schema change and an integrator's call —
 * see `DECISIONS.md`, 2026-09-08, `R-BRAKES-BLIND`.
 */

import { registerStub } from '../contracts/stubs'

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

const UNMEASURED: FailureCount = { failures: 0, sample: 0, measurable: false }

/** How many of the last `n` drafts the quality judge rejected. */
export interface JudgeOutcomeCounter {
  recentJudgeOutcomes(trailingDrafts: number): Promise<FailureCount>
}

/** How many publish attempts failed inside the window. */
export interface PublishOutcomeCounter {
  recentPublishOutcomes(windowHours: number): Promise<FailureCount>
}

export class UnrecordedPublishOutcomes implements PublishOutcomeCounter {
  constructor() {
    registerStub({
      contract: 'PublishOutcomeCounter',
      filledBy:
        "a durable record of a publish attempt and how it ended — `publish_intents` deletes its row on the commonest failure, so it cannot answer this",
      behaviour:
        'reports that nothing is measurable, so the publish error-rate trip can never fire in production',
      mustBeGoneBy: 'M10',
    })
  }

  async recentPublishOutcomes(): Promise<FailureCount> {
    return UNMEASURED
  }
}
