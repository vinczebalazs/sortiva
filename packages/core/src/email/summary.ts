import { assertNoDenominator } from './denominator'
import { copyKeysIn, type EmailContent, type EmailSection } from './content'

/**
 * The flagship retention email: what happened last month, what we held back and
 * why, and what is worth doing next.
 *
 * Its whole posture is in one rule — it never states a count against a total.
 * The plan sells a ceiling ("up to 1 article per day, quality permitting"), so
 * a summary that says "22 of 30" converts a quality decision into a shortfall
 * and makes every held-back topic read as a failure. Skipped days are not
 * missed days; they simply do not appear.
 */

export interface HeldBackTopic {
  /** Looked up when the summary is assembled, never read from a stored row. */
  readonly title: string
  /** A copy key for the plain-language reason, e.g. the store lacks product detail. */
  readonly reasonKey: string
}

export interface NextOpportunity {
  readonly action: 'create' | 'optimize' | 'refresh' | 'fix' | 'hold'
  /** The page, collection or query it concerns. Looked up at assembly time. */
  readonly subject: string
}

/**
 * The month's facts, assembled by the job from `articles`, `gate_decisions` and
 * `opportunities`. Plain numbers and looked-up strings: this module decides how
 * to say them, and nothing here reads a database.
 */
export interface MonthlySummaryFacts {
  /** `YYYY-MM`, the same string as the send's dedupe key. */
  readonly period: string
  /** How the month is named to a human — "August 2026" — in the account's language. */
  readonly periodLabel: string
  readonly articlesPublished: number
  readonly heldBack: readonly HeldBackTopic[]
  readonly optimizeRecommendationsGenerated: number
  readonly optimizeRecommendationsApplied: number
  readonly repairsCompleted: number
  readonly merchantTasksResolved: number
  readonly nextOpportunities: readonly NextOpportunity[]
  readonly openOpportunityCount: number
}

const K = {
  subject: 'email.monthlySummary.subject',
  preview: 'email.monthlySummary.preview',
  heading: 'email.monthlySummary.heading',
  intro: 'email.monthlySummary.intro',
  publishedSome: 'email.monthlySummary.publishedSome',
  publishedOne: 'email.monthlySummary.publishedOne',
  publishedNone: 'email.monthlySummary.publishedNone',
  heldHeading: 'email.monthlySummary.heldHeading',
  heldNone: 'email.monthlySummary.heldNone',
  heldTopic: 'email.monthlySummary.heldTopic',
  actionsHeading: 'email.monthlySummary.actionsHeading',
  optimizeGenerated: 'email.monthlySummary.optimizeGenerated',
  optimizeApplied: 'email.monthlySummary.optimizeApplied',
  repairs: 'email.monthlySummary.repairs',
  merchantTasks: 'email.monthlySummary.merchantTasks',
  actionsNone: 'email.monthlySummary.actionsNone',
  nextHeading: 'email.monthlySummary.nextHeading',
  nextItemPrefix: 'email.monthlySummary.nextItem',
  nextNone: 'email.monthlySummary.nextNone',
  cta: 'email.monthlySummary.cta',
} as const

/**
 * Zero is said in words, not as a number, because "0 articles" reads as a score
 * and "no articles went live" reads as what happened. A month with nothing in
 * it is a normal month for a store whose quality bar held.
 */
function publishedLine(count: number) {
  if (count === 0) return { key: K.publishedNone }
  if (count === 1) return { key: K.publishedOne }
  return { key: K.publishedSome, params: { count } }
}

export function monthlySummaryContent(
  facts: MonthlySummaryFacts,
  links: { readonly dashboardUrl: string; readonly unsubscribeUrl: string },
): EmailContent {
  const held: EmailSection = {
    heading: { key: K.heldHeading },
    lines:
      facts.heldBack.length === 0
        ? [{ key: K.heldNone }]
        : // Two lines per topic: what it was, then why it did not go out. The
          // reason is itself a copy key, so it is resolved by the renderer like
          // any other sentence rather than pasted in as a parameter.
          facts.heldBack.flatMap((topic) => [
            { key: K.heldTopic, params: { title: topic.title } },
            { key: topic.reasonKey },
          ]),
  }

  const actionLines = []
  if (facts.optimizeRecommendationsGenerated > 0) {
    actionLines.push({
      key: K.optimizeGenerated,
      params: { count: facts.optimizeRecommendationsGenerated },
    })
  }
  if (facts.optimizeRecommendationsApplied > 0) {
    actionLines.push({
      key: K.optimizeApplied,
      params: { count: facts.optimizeRecommendationsApplied },
    })
  }
  if (facts.repairsCompleted > 0) {
    actionLines.push({ key: K.repairs, params: { count: facts.repairsCompleted } })
  }
  if (facts.merchantTasksResolved > 0) {
    actionLines.push({ key: K.merchantTasks, params: { count: facts.merchantTasksResolved } })
  }

  const actions: EmailSection = {
    heading: { key: K.actionsHeading },
    lines: actionLines.length > 0 ? actionLines : [{ key: K.actionsNone }],
  }

  const next: EmailSection = {
    heading: { key: K.nextHeading },
    lines:
      facts.nextOpportunities.length === 0
        ? [{ key: K.nextNone }]
        : facts.nextOpportunities.map((opportunity) => ({
            // One sentence per kind of action: "improve your existing page for
            // X" says something, "optimize — X" does not.
            key: `${K.nextItemPrefix}.${opportunity.action}`,
            params: { subject: opportunity.subject },
          })),
  }

  return {
    templateId: 'monthly-summary',
    subject: { key: K.subject, params: { period: facts.periodLabel } },
    preview: { key: K.preview, params: { period: facts.periodLabel } },
    heading: { key: K.heading, params: { period: facts.periodLabel } },
    blocks: [{ key: K.intro }, publishedLine(facts.articlesPublished)],
    sections: [held, actions, next],
    cta: { label: { key: K.cta }, url: links.dashboardUrl },
    unsubscribeUrl: links.unsubscribeUrl,
  }
}

/**
 * The denominator rule, applied to the copy rather than to the rendered email.
 *
 * Judging the rendered words would fail on a merchant's own topic title — "A
 * History of Wool" contains "of" and is nobody's denominator. Judging the copy
 * templates, placeholders still unfilled, catches exactly the thing the rule
 * exists for: a sentence *we* wrote that frames output against a total.
 *
 * `lookup` is the string catalogue. It lives in `packages/ui`, which this
 * package must not import, so the caller passes it in.
 */
export function assertSummaryCopyHasNoDenominator(
  content: EmailContent,
  lookup: (key: string) => string,
): void {
  for (const key of copyKeysIn(content)) assertNoDenominator(lookup(key))
}
