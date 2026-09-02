/**
 * Where the two rate-based brakes get their numbers — and, right now, why they
 * cannot.
 *
 * The spend caps read `spend_events`, a table that exists and is written on
 * every paid call. The other two brakes need counts nobody records yet:
 *
 * - **How many recent drafts the quality judge rejected.** The judge belongs to
 *   the content engine, which has no table in the schema: no `articles`, no
 *   record of a gate decision. So there is nothing to count.
 * - **How many publish attempts failed in the last hour.** Publishing goes
 *   through `publish_intents`, which is also not in the schema yet.
 *
 * Rather than leave the two trips unbuilt, or — much worse — build them against
 * a query that silently returns zero forever and looks healthy, each is a
 * declared seam with a stand-in that says out loud that it knows nothing. The
 * stand-ins register in the repo's stub registry, so `pnpm stubs:report` lists
 * them and the milestone gate that turns on `--fail-if-any` fails while they
 * are still wired.
 *
 * The arithmetic they feed is real and tested (`auto-trips.ts`); what is
 * missing is only the counting. When the owning lanes land their tables, the
 * replacement is a query, not a redesign.
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

export class UnrecordedJudgeOutcomes implements JudgeOutcomeCounter {
  constructor() {
    registerStub({
      contract: 'JudgeOutcomeCounter',
      filledBy: 'the content-engine lane, once a draft\'s gate decision is stored',
      behaviour:
        'reports that nothing is measurable, so the judge fail-rate trip can never fire in production',
      mustBeGoneBy: 'M10',
    })
  }

  async recentJudgeOutcomes(): Promise<FailureCount> {
    return UNMEASURED
  }
}

export class UnrecordedPublishOutcomes implements PublishOutcomeCounter {
  constructor() {
    registerStub({
      contract: 'PublishOutcomeCounter',
      filledBy: 'the publishing lane, once `publish_intents` exists',
      behaviour:
        'reports that nothing is measurable, so the publish error-rate trip can never fire in production',
      mustBeGoneBy: 'M10',
    })
  }

  async recentPublishOutcomes(): Promise<FailureCount> {
    return UNMEASURED
  }
}
