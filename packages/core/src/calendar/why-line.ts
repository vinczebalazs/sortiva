import type { EvidenceFact } from '../contracts/opportunities'
import {
  REPLENISHMENT_WHY_COMPETITOR,
  REPLENISHMENT_WHY_EXPLORATION,
  REPLENISHMENT_WHY_REFRESH_POSITION,
  type TemplatedWhyLine,
} from './replenishment'

/**
 * The sentence under a day on the content calendar, with the numbers it needs.
 *
 * A topic stores only the *key* of its explanation — `why_line` is one text
 * column and there is nowhere beside it for the values. So every screen that
 * shows a calendar day has to put the values back, and until now none of them
 * did: they sent an empty bag, and a merchant read "There is steady demand
 * here — around {volume} searches a month" with the braces showing.
 *
 * Putting them back is possible because the planners choose the key from things
 * that persist. This function is that reconstruction, in one place rather than
 * once per screen, and it is written so that a sentence it cannot fill is
 * replaced by one it can — never left with a blank in it.
 */

/** The opportunity a calendar day was planned from, as much of it as an explanation needs. */
export interface TopicWhyOpportunity {
  readonly reasonTemplateKey: string
  readonly reasonParams: Readonly<Record<string, string | number>>
  readonly evidence: readonly EvidenceFact[]
}

export interface TopicWhyInput {
  /** `topics.why_line` — the key the planner recorded, or null on an older row. */
  readonly whyLineKey: string | null | undefined
  /** What this screen says when there is nothing better: `topic.auto` or `topic.manual_addition`. */
  readonly fallbackKey: string
  readonly opportunity: TopicWhyOpportunity | null
}

/**
 * Keys the calendar composes itself, whose sentences state a fact about the
 * calendar rather than about the store, and so ask for no values at all.
 */
const SELF_CONTAINED: readonly string[] = [
  'topic.auto',
  'topic.manual_addition',
  REPLENISHMENT_WHY_EXPLORATION,
  REPLENISHMENT_WHY_COMPETITOR,
]

export function topicWhyLine(input: TopicWhyInput): TemplatedWhyLine {
  const key = input.whyLineKey ?? input.fallbackKey
  const opportunity = input.opportunity

  if (SELF_CONTAINED.includes(key)) return { templateKey: key, params: {} }

  // The common case, and the one the Opportunities screen has always got right:
  // the day carries the opportunity's own reason, so it carries its values too.
  // A topic added by hand lands here as well — Gate 1's verdict is written onto
  // the opportunity row as its reason, key and values together.
  if (opportunity && key === opportunity.reasonTemplateKey) {
    return { templateKey: key, params: opportunity.reasonParams }
  }

  if (key === REPLENISHMENT_WHY_REFRESH_POSITION) {
    const position = ourPosition(opportunity?.evidence ?? [])
    if (position !== null) return { templateKey: key, params: { position } }
  }

  // Everything left is a sentence whose values were worked out when the day was
  // planned and were never written down — where a pattern-matching day's
  // {dimension} goes, since the patterns it was compared against have moved on
  // since. Rather than print the blank, the day falls back to the reason the
  // opportunity itself carries, which is stored as a matched pair and so can
  // always be filled. That is the same last resort the planner uses when
  // nothing more specific applies.
  return opportunity
    ? { templateKey: opportunity.reasonTemplateKey, params: opportunity.reasonParams }
    : { templateKey: input.fallbackKey, params: {} }
}

/**
 * Where the store's own page sits for this subject. The two names are the two
 * the detectors record it under; the replenishment planner reads exactly these
 * when it decides a day is explained by a ranking position.
 */
function ourPosition(evidence: readonly EvidenceFact[]): number | null {
  return numericFact(evidence, 'mean_position') ?? numericFact(evidence, 'our_position')
}

function numericFact(evidence: readonly EvidenceFact[], key: string): number | null {
  const fact = evidence.find((f) => f.key === key)
  if (!fact) return null
  const value = typeof fact.value === 'number' ? fact.value : Number(fact.value)
  return Number.isFinite(value) ? value : null
}
