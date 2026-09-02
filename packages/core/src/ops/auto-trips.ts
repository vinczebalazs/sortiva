/**
 * The brakes that are not about money.
 *
 * Three conditions pause the product on their own, and none of them is a
 * dollar total:
 *
 * - **Most drafts are failing the quality judge.** When more than a set share
 *   of recent drafts are rejected, the writing did not suddenly get worse — a
 *   prompt version or a model changed under us. Carrying on would mass-produce
 *   rejects, or worse, mass-publish something the judge should have caught, so
 *   all generation stops and somebody is paged.
 * - **Publishing keeps failing.** When more than a set share of publish
 *   attempts fail over an hour, the fault is at the platform. Publishing stops;
 *   writing does not, because a store that cannot be posted to today is still
 *   worth having drafts for tomorrow.
 * - **One store has used up its daily allowance of a paid, click-triggered
 *   analysis.** That store stops making *those* calls for the rest of the day
 *   and nothing else about it changes.
 *
 * Pure, like the spend arithmetic beside it: handed counts and ceilings,
 * answers yes or no. It never reads a database, never looks at a clock, and
 * never asks the analytics vendor anything — the vendor watches these numbers
 * and can raise an alert, but a brake that stops working when a dashboard is
 * slow is not a brake.
 */

export interface RateVerdict {
  tripped: boolean
  /** How many of the sample failed. */
  failures: number
  /** How many were looked at. */
  sample: number
  /** `failures / sample`, or 0 when there is nothing to divide. */
  rate: number
  /** Written for whoever finds the switch, from the numbers above and nothing else. */
  reason: string | null
}

function percent(rate: number): string {
  return `${Math.round(rate * 100)}%`
}

function rateVerdict(input: {
  failures: number
  sample: number
  rateMax: number
  minimumSample: number
  describe: (rate: number, failures: number, sample: number) => string
}): RateVerdict {
  const { failures, sample } = input
  const rate = sample === 0 ? 0 : failures / sample

  // Below the minimum sample the ratio is noise: two failures out of two is
  // 100% and means nothing. Waiting for the sample is the difference between a
  // brake and a hair trigger that pauses the product every quiet morning.
  if (sample < input.minimumSample || rate <= input.rateMax) {
    return { tripped: false, failures, sample, rate, reason: null }
  }
  return {
    tripped: true,
    failures,
    sample,
    rate,
    reason: input.describe(rate, failures, sample),
  }
}

/**
 * The quality judge failing most of what it is shown.
 *
 * Measured over a fixed count of recent drafts rather than over a period, so
 * the rule means the same thing for a quiet week as for a busy one. The sample
 * has to be full before it can trip: the whole claim is "this is unlike the
 * last fifty", which needs fifty.
 */
export function judgeFailRateVerdict(input: {
  rejected: number
  graded: number
  /** From `packages/rules`: the share of rejections that means something upstream broke. */
  rateMax: number
  /** From `packages/rules`: how many recent drafts the share is measured over. */
  trailingDrafts: number
}): RateVerdict {
  return rateVerdict({
    failures: input.rejected,
    sample: input.graded,
    rateMax: input.rateMax,
    minimumSample: input.trailingDrafts,
    describe: (rate, failures, sample) =>
      `The quality judge rejected ${failures} of the last ${sample} drafts (${percent(rate)}), over the ` +
      `${percent(input.rateMax)} ceiling. That pattern is almost always a prompt or model change rather ` +
      `than worse writing, so all generation is paused until an operator has looked.`,
  })
}

/**
 * Publishing failing at the far end.
 *
 * Measured over an hour rather than over a count, because the thing being
 * caught is an outage and outages have a duration. A minimum sample still
 * applies, so one failed post in a quiet hour does not stop everybody.
 */
export function publishErrorRateVerdict(input: {
  failed: number
  attempted: number
  /** From `packages/rules`: the share of failures that means the platform, not us. */
  rateMax: number
  windowHours: number
  minimumSample: number
}): RateVerdict {
  return rateVerdict({
    failures: input.failed,
    sample: input.attempted,
    rateMax: input.rateMax,
    minimumSample: input.minimumSample,
    describe: (rate, failures, sample) =>
      `${failures} of ${sample} publish attempts failed in the last ${input.windowHours}h (${percent(rate)}), ` +
      `over the ${percent(input.rateMax)} ceiling. Publishing is paused; drafts are still being written.`,
  })
}

/**
 * How few publish attempts is too few to judge an hour by. Not in
 * `signals.config.yaml` because it decides nothing about a merchant's store —
 * it is arithmetic hygiene on a ratio, in the same family as "a day cannot be
 * unusual against a median that includes it".
 */
export const PUBLISH_ERROR_MINIMUM_SAMPLE = 5

export interface CallTypeCapVerdict {
  tripped: boolean
  used: number
  cap: number
  reason: string | null
}

/**
 * One store's daily allowance of a paid analysis it triggers by clicking.
 *
 * A count rather than a dollar total: each of these is a fixed bundle of a paid
 * search read and a model call, so counting them is the same ceiling expressed
 * in the unit the merchant actually sees.
 */
export function callTypeCapVerdict(input: {
  used: number
  cap: number
  /** What the merchant asked for, in words — this is read by an operator. */
  what: string
}): CallTypeCapVerdict {
  if (input.used < input.cap) {
    return { tripped: false, used: input.used, cap: input.cap, reason: null }
  }
  return {
    tripped: true,
    used: input.used,
    cap: input.cap,
    reason:
      `This store has run ${input.used} ${input.what} today, which is its daily allowance of ` +
      `${input.cap}. Only that is paused; everything else about the store carries on.`,
  }
}
