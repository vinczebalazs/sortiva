import { topicWhyLine } from '@sortiva/core'
import type { OpportunityRow } from '@sortiva/db'

/**
 * The one place the calendar's three routes turn a stored day into the sentence
 * a merchant reads under it. Adapting the row is all that happens here; which
 * values a sentence gets, and what to do when a sentence cannot be filled, is
 * `topicWhyLine`'s decision in `packages/core`.
 */
export function calendarWhyLine(
  whyLineKey: string | null | undefined,
  opportunity: OpportunityRow | null,
  fallbackKey: 'topic.auto' | 'topic.manual_addition',
) {
  return topicWhyLine({
    whyLineKey,
    fallbackKey,
    opportunity: opportunity
      ? {
          reasonTemplateKey: opportunity.reasonTemplateKey,
          reasonParams: (opportunity.reasonParamsJson ?? {}) as Readonly<Record<string, unknown>>,
          evidence: (opportunity.evidenceJson ?? []) as readonly { key: string; value: unknown }[],
        }
      : null,
  })
}
