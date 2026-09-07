import { driftPolicies } from '@sortiva/core'
import en from '../../strings/en.json'
import { catalogKeyFor } from '../opportunities/why'

/**
 * Which explanations the product can be asked for, and which ones it actually
 * has words for.
 *
 * The renderer answers a key it has no sentence for with an honest admission
 * ("the reasoning for this one isn't available yet") and carries on. That is
 * the right thing to show a merchant — better than a raw key, and far better
 * than a crash — but it is also why two whole families of explanation shipped
 * blank without anyone noticing: nothing anywhere compared the set of keys the
 * engine can emit against the set the catalogue holds.
 *
 * This file is that comparison, so the gap fails a build instead of reaching a
 * merchant. The loudness lives here, in CI, and deliberately not at runtime.
 */

/** A sentence exists for this key, whether under `template.` or an alias. */
export function hasCopy(reasonKey: string): boolean {
  return (en as Record<string, string>)[catalogKeyFor(reasonKey)] !== undefined
}

export function reasonKeysWithoutCopy(keys: readonly string[]): readonly string[] {
  return keys.filter((key) => !hasCopy(key))
}

/** The `{placeholders}` a sentence expects the engine to fill. */
export function placeholdersIn(reasonKey: string): readonly string[] {
  const sentence = (en as Record<string, string>)[catalogKeyFor(reasonKey)] ?? ''
  return [...sentence.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!)
}

/**
 * The explanations a drifted article can be given, worked out from the drift
 * policy table rather than typed out — so a new kind of drift arrives here with
 * no sentence and fails, instead of arriving on a merchant's screen blank.
 *
 * Mirrors the key `buildDriftOpportunity` composes. The pairing is held in
 * place from the other side too: the repair suite pins the key a deleted
 * product produces.
 */
export function repairReasonKeys(): readonly string[] {
  return driftPolicies().map((policy) =>
    policy.signalType === 'broken_product_reference'
      ? 'broken_product_reference.fix'
      : `product_change_impact.${policy.kind}`,
  )
}

/** The only two numbers the repair path hands the renderer. */
export const REPAIR_REASON_PARAMS: readonly string[] = ['article_id', 'references']

/**
 * Every reason an opportunity row can carry, which is every sentence the
 * Opportunities card, the drawer, the calendar popover and the dashboard can
 * be asked to render as a "why".
 *
 * Gate rejections and precondition lines are a separate family with their own
 * producers; they reach the same renderer and want the same treatment.
 */
export const OPPORTUNITY_REASON_KEYS: readonly string[] = [
  // The weekly scan's signals.
  'striking_distance.refresh_ours',
  'striking_distance.optimize',
  'low_ctr_at_strong_rank.optimize',
  'content_decay.refresh',
  'cannibalization.fix',
  'uncovered_commercial_query.create_with_link',
  'uncovered_commercial_query.create',
  'existing_target.prefer_optimize',
  'competitor_coverage_gap.create',
  'product_family_coverage_gap.create',
  'quality_rejection.insufficient_richness',
  'missing_or_weak_metadata.optimize',
  'existing_page_intent_gap.optimize',
  'indexing_issue.fix',
  // A published article of ours the merchant asked us to rewrite.
  'freshness_opportunity.requested',
  'freshness_opportunity.our_own_article',
  ...repairReasonKeys(),
]

/**
 * Reasons the product can produce today that still have no words.
 *
 * Every one of these is a card on the Opportunities screen — the store's
 * central surface — whose explanation currently reads "the reasoning for this
 * one isn't available yet". They are listed rather than silently tolerated:
 * the test below fails if anything joins them without being written down, and
 * fails again when one of them is finally given a sentence and left here.
 *
 * Writing these is not this card's work: they belong to the weekly scan's
 * signals, not the repair path.
 */
export const REASON_KEYS_AWAITING_COPY: readonly string[] = [
  'striking_distance.refresh_ours',
  'striking_distance.optimize',
  'low_ctr_at_strong_rank.optimize',
  'content_decay.refresh',
  'cannibalization.fix',
  'uncovered_commercial_query.create_with_link',
  'uncovered_commercial_query.create',
  'competitor_coverage_gap.create',
  'product_family_coverage_gap.create',
  'missing_or_weak_metadata.optimize',
  'existing_page_intent_gap.optimize',
  'indexing_issue.fix',
]
