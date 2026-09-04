import type { ScoringConfig } from '@sortiva/rules'
import type { EvidenceFact } from '../contracts/opportunities'
import { confidenceScore } from '../opportunities/scoring'
import type { OpportunityDraft } from '../opportunities/build'
import type { OpportunityTaskDraft } from '../opportunities/tasks'
import { driftPolicyFor, type DriftKind } from './drift'
import { routeRepair, type RepairRouting, type RepairRoutingContext } from './routing'

/**
 * A drifted article, expressed as the same kind of object as every other piece
 * of work the product proposes.
 *
 * Repairs could have been their own list with their own screen. They are not,
 * deliberately: a merchant should see "this page names a product you withdrew"
 * in the same place, with the same evidence and the same outcome, as "this page
 * is one position off the front page". One list, one vocabulary, one set of
 * rules about what happens automatically and what waits for them.
 */

export interface DriftedReference {
  readonly placeholderKey: string
  readonly productId: string | null
  readonly productTitle: string
  /** `link`, `recommendation` or `mention` — a passing mention is weaker evidence than a recommendation. */
  readonly refType: 'link' | 'recommendation' | 'mention'
}

/** One article, one thing that went wrong under it, and what we know about it. */
export interface DriftObservation {
  readonly accountId: string
  readonly articleId: string
  readonly articleTitle: string
  readonly kind: DriftKind
  /** The references this drift breaks. Empty for a drift that is about the range rather than a product. */
  readonly references: readonly DriftedReference[]
  /** When the store made the change, as the store reported it. */
  readonly occurredAt: string
  /** Only for a range whose attributes moved: what the article compared on, and what the range differs by now. */
  readonly axes?: { readonly writtenWith: readonly string[]; readonly nowIs: readonly string[] }
}

export interface DriftOpportunityContext {
  readonly rulesVersion: string
  readonly detectedAt: string
  readonly limitedIntelligence: boolean
  readonly routing: RepairRouting
}

/**
 * The facts behind the card, each stamped with where it came from.
 *
 * Every one of them is read from the merchant's own store, so the source is
 * always the catalogue and there is no observation window: this is not a
 * measurement over 28 days, it is a thing that is either true right now or is
 * not.
 */
export function driftEvidence(
  observation: DriftObservation,
  at: string,
): readonly EvidenceFact[] {
  const facts: EvidenceFact[] = [
    { key: 'drift_kind', value: observation.kind, source: 'catalog', fetchedAt: at },
    { key: 'article_title', value: observation.articleTitle, source: 'catalog', fetchedAt: at },
    { key: 'changed_at', value: observation.occurredAt, source: 'catalog', fetchedAt: at },
  ]
  if (observation.references.length > 0) {
    facts.push({
      key: 'affected_references',
      value: observation.references.length,
      source: 'catalog',
      fetchedAt: at,
    })
    for (const reference of observation.references) {
      facts.push({
        key: `reference_${reference.placeholderKey}`,
        value: `${reference.refType}: ${reference.productTitle}`,
        source: 'catalog',
        fetchedAt: at,
      })
    }
  }
  if (observation.axes) {
    facts.push({
      key: 'axes_written_with',
      value: observation.axes.writtenWith.join(', '),
      source: 'catalog',
      fetchedAt: at,
    })
    facts.push({
      key: 'axes_now',
      value: observation.axes.nowIs.join(', '),
      source: 'catalog',
      fetchedAt: at,
    })
  }
  return facts
}

/**
 * What the merchant is asked to do, or told we are doing.
 *
 * `opportunity_tasks.description` is a plain text column with no companion
 * template key — the schema decided that, not this card — so a task's words are
 * composed here from what was measured, exactly as the rest of the opportunity
 * engine already composes them. Never by a model, and never re-composed at
 * display time.
 */
export function driftTasks(
  observation: DriftObservation,
  routing: RepairRouting,
): readonly OpportunityTaskDraft[] {
  const names = observation.references.map((reference) => reference.productTitle)
  const named = names.length > 0 ? `"${names.join('", "')}"` : 'a product'

  if (routing.route === 'gate3_refresh') {
    return [
      {
        kind: 'schedule_topic',
        description:
          observation.kind === 'family_axes_changed'
            ? `Rewrite "${observation.articleTitle}" — the range it compares no longer differs the way it did when it was written.`
            : `Rewrite "${observation.articleTitle}" — it recommends ${named}, which cannot be bought, and the recommendation itself has to change.`,
      },
    ]
  }

  if (routing.route === 'action_card') {
    return [
      {
        kind: 'repair_reference',
        description: `"${observation.articleTitle}" recommends ${named}, which your store no longer sells. Download the repaired version and replace the published article.`,
      },
    ]
  }

  return [
    {
      kind: 'repair_reference',
      description: `"${observation.articleTitle}" recommends ${named}, which your store no longer sells. We are replacing it with the closest product in the same family and updating the published article.`,
    },
  ]
}

/**
 * How much of the page is wrong.
 *
 * No spec states a formula for a repair's size, and a percentile rank against
 * other repairs is what turns this into the `impact` band, so all this has to
 * do is order one broken article against another. The count of broken mentions
 * does that honestly: a guide whose three recommendations have all been
 * withdrawn is more wrong than one whose single passing mention has. A range
 * whose attributes moved counts as one.
 */
export function driftMagnitude(observation: DriftObservation): number {
  return Math.max(1, observation.references.length)
}

export function buildDriftOpportunity(
  observation: DriftObservation,
  context: DriftOpportunityContext,
  scoring: ScoringConfig,
): OpportunityDraft {
  const policy = driftPolicyFor(observation.kind)
  const evidence = driftEvidence(observation, context.detectedAt)
  const confidence = confidenceScore(
    {
      evidence,
      preconditions: [],
      limitedIntelligence: context.limitedIntelligence,
      substanceFloorMargin: false,
      // The store told us this itself. There is nothing to confirm across two
      // scans the way a movement in search data has to be.
      validatedAcrossConsecutiveScans: true,
    },
    scoring.confidence,
  )

  return {
    accountId: observation.accountId,
    signalType: policy.signalType,
    entityType: 'article',
    // The article, not the product. Main §14.1 acts per article — it flags
    // every article referencing the product, logs the repair per article, and
    // hands the merchant a card per article — and this column is what the
    // one-open-row-per-signal index dedupes on. Keyed on the product instead,
    // three broken articles would collapse into one card naming one of them.
    entityRef: observation.articleId,
    evidence,
    confidence: confidence.confidence,
    confidenceBand: confidence.band,
    reasonTemplateKey:
      policy.signalType === 'broken_product_reference'
        ? 'broken_product_reference.fix'
        : `product_change_impact.${observation.kind}`,
    reasonParams: {
      article_id: observation.articleId,
      references: observation.references.length,
    },
    recommendedAction: context.routing.action,
    preconditions: [],
    // Never `new`. A page on a merchant's site saying something untrue is not a
    // suggestion waiting for their opinion — the work is accepted the moment it
    // is found, and what varies is who does it and whether it costs a day.
    status: 'accepted',
    rulesVersion: context.rulesVersion,
    limitedIntelligence: context.limitedIntelligence,
    detectedAt: context.detectedAt,
    rawScore: driftMagnitude(observation),
    tasks: driftTasks(observation, context.routing),
  }
}

/** The routing decision and the opportunity in one call, for a caller that needs both. */
export function planRepair(
  observation: DriftObservation,
  routingContext: RepairRoutingContext,
  context: Omit<DriftOpportunityContext, 'routing'>,
  scoring: ScoringConfig,
): { readonly routing: RepairRouting; readonly draft: OpportunityDraft } {
  const routing = routeRepair(observation.kind, routingContext)
  return { routing, draft: buildDriftOpportunity(observation, { ...context, routing }, scoring) }
}
