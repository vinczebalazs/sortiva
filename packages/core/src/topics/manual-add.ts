import type { Gate1Result } from '../gates/gate1'

/**
 * The manual-add answer, in the four words main §8.7 uses: "proceed,
 * proceed-with-warning ..., or reject with the standard reason card" plus the
 * fourth main §7.7 forces on us — a match converts the candidate instead of
 * either of those. This is also the exact vocabulary
 * `addTopicResponseSchema.outcome` (`packages/core/src/api/schemas.ts`, built
 * by M0) already froze, so this module's only job is mapping Gate 1's own
 * richer outcome onto it — never inventing a competing name for the same four
 * answers.
 */
export const MANUAL_ADD_OUTCOMES = ['planned', 'planned_with_warning', 'converted', 'rejected'] as const
export type ManualAddOutcome = (typeof MANUAL_ADD_OUTCOMES)[number]

/**
 * A manually-added topic passes the same Gate 1 as an auto one (main §8.7);
 * this is purely the translation from Gate 1's nine-way outcome to the four
 * words the merchant-facing form ever shows. `held_insufficient_substance`
 * collapses into `rejected` here — the finer HOLD-vs-rejected distinction is
 * an audit-trail concern (`gate_decisions.outcome`), not something the
 * frozen wire contract has a slot for.
 */
export function manualAddOutcome(result: Gate1Result): ManualAddOutcome {
  if (result.conversion) return 'converted'
  if (!result.admitted) return 'rejected'
  if (result.outcome === 'admitted_with_warning') return 'planned_with_warning'
  return 'planned'
}
