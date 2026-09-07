import {
  confidenceScore,
  merchantRefreshBlockers,
  rankByImpact,
  type EvidenceFact,
  type Logger,
  type OpportunityDraft,
  type RefreshBlocker,
} from '@sortiva/core'
import {
  accountScope,
  articleRefreshFacts,
  articleSubject,
  insertOpportunityTasks,
  upsertOpportunity,
  type Db,
} from '@sortiva/db'
import { rules } from '@sortiva/rules'
import { runtimeLogger } from '../runtime/logging'

/**
 * The refresh pool's front door: an article of ours goes in, and comes out as
 * a piece of work waiting for a calendar day like any other.
 *
 * Two things arrive here, and they are treated identically on purpose. A
 * merchant pressing "Request refresh" on an article we published for them, and
 * an improve-this-page suggestion that turned out to have landed on one of our
 * own articles — which the product refuses to answer with a list of edits,
 * because a page we wrote is ours to rewrite rather than theirs to patch.
 * Before this existed, the second of those was refused with nowhere to go: the
 * merchant saw a card offering a button that could only ever say no.
 *
 * **There is no second, quieter route onto the calendar.** This writes one
 * thing — a piece of work marked as accepted — and then stops. Which day it
 * lands on, whether it lands at all, and how many rewrites may share a batch
 * with new coverage are decided by the same replenishment pass that places
 * everything else, under the same cap. Nothing here reaches the calendar, and
 * nothing here can put a rewrite on tomorrow because somebody asked nicely.
 */

/** Who asked. Kept apart only so the merchant reads the right sentence; the rules applied are identical. */
export type RefreshRequestSource =
  /** The merchant pressed "Request refresh" on the article. */
  | 'merchant_request'
  /** An improve-this-page suggestion landed on an article we published. */
  | 'optimize_on_our_own_article'

export const REFRESH_REQUEST_REASON_KEYS: Readonly<Record<RefreshRequestSource, string>> = {
  merchant_request: 'freshness_opportunity.requested',
  optimize_on_our_own_article: 'freshness_opportunity.our_own_article',
}

export interface RequestRefreshDeps {
  readonly db: Db
  readonly now?: () => Date
  readonly logger?: Logger
}

export interface RequestRefreshInput {
  readonly accountId: string
  readonly articleId: string
  readonly source: RefreshRequestSource
}

export type RequestRefreshResult =
  /** In the pool. `created` is false when a request for this article was already waiting — a second press is not a second rewrite. */
  | { readonly ok: true; readonly opportunityId: string; readonly created: boolean }
  | { readonly ok: false; readonly reason: 'article_not_found' }
  | { readonly ok: false; readonly reason: 'not_eligible'; readonly blockers: readonly RefreshBlocker[] }

/**
 * A rewrite is a re-attempt at the same subject, so the piece of work carries
 * the intent class and the product families the original article was written
 * against. The scheduler reads the intent class off this to know which article
 * template the rewrite needs; without it, the placement is refused rather than
 * guessed.
 */
function subjectEvidence(
  subject: { readonly intentClass: string; readonly familyIds: readonly string[] },
  articleId: string,
  at: string,
): readonly EvidenceFact[] {
  const facts: EvidenceFact[] = [
    { key: 'intent_class', value: subject.intentClass, source: 'catalog', fetchedAt: at },
    { key: 'refreshes_article', value: articleId, source: 'catalog', fetchedAt: at },
  ]
  for (const familyId of subject.familyIds) {
    facts.push({ key: 'family_id', value: familyId, source: 'catalog', fetchedAt: at })
  }
  return facts
}

export async function requestArticleRefresh(
  deps: RequestRefreshDeps,
  input: RequestRefreshInput,
): Promise<RequestRefreshResult> {
  const log = deps.logger ?? runtimeLogger()
  const now = (deps.now ?? (() => new Date()))()
  const at = now.toISOString()
  const scope = accountScope(input.accountId)
  const config = rules()

  const facts = await articleRefreshFacts(deps.db, scope, input.articleId)
  if (!facts) return { ok: false, reason: 'article_not_found' }

  const blockers = merchantRefreshBlockers(
    {
      articleId: facts.articleId,
      published: facts.published,
      publishedViaOverride: facts.publishedViaOverride,
      lastRefreshedAt: facts.lastRefreshedAt,
      repairPending: facts.repairPending,
      // Where it ranks and how often it is shown are what the weekly scan uses
      // to decide which articles are worth proposing unprompted. A merchant who
      // has pressed the button has already answered that question, so these are
      // deliberately left unknown here rather than fetched and then ignored.
      meanPosition: null,
      impressions: null,
      storeMedianImpressions: null,
    },
    {
      positionMin: config.defaults.learning.refresh.position_min,
      positionMax: config.defaults.learning.refresh.position_max,
      cooldownDays: config.defaults.learning.refresh.cooldown_days,
    },
    at,
  )

  if (blockers.length > 0) {
    log.info('refresh_request_refused', {
      account_id: input.accountId,
      article_id: input.articleId,
      source: input.source,
      blockers,
    })
    return { ok: false, reason: 'not_eligible', blockers }
  }

  const subject = await articleSubject(deps.db, scope, input.articleId)
  if (!subject) return { ok: false, reason: 'article_not_found' }

  const evidence = subjectEvidence(subject, input.articleId, at)
  const confidence = confidenceScore(
    {
      evidence,
      preconditions: [],
      limitedIntelligence: false,
      substanceFloorMargin: false,
      // Somebody asked for this in as many words. There is nothing to confirm
      // across two scans the way a movement in search data has to be.
      validatedAcrossConsecutiveScans: true,
    },
    config.defaults.scoring.confidence,
  )

  const draft: OpportunityDraft = {
    accountId: input.accountId,
    signalType: 'freshness_opportunity',
    // The article, not the address it is published at: the address can change
    // and the piece of writing is what is being asked about. It is also what
    // the one-open-row-per-signal index dedupes on, so two presses on the same
    // article are one piece of work rather than two rewrites of it.
    entityType: 'article',
    entityRef: input.articleId,
    evidence,
    confidence: confidence.confidence,
    confidenceBand: confidence.band,
    reasonTemplateKey: REFRESH_REQUEST_REASON_KEYS[input.source],
    reasonParams: { article_title: subject.title },
    recommendedAction: 'REFRESH',
    preconditions: [],
    // Accepted, not waiting for an opinion: somebody has already given one.
    // This is the same posture every rewrite of our own content takes — the
    // merchant's lever is the calendar's own veto, not an approval click.
    status: 'accepted',
    rulesVersion: config.rulesVersion,
    limitedIntelligence: false,
    detectedAt: at,
    // Ranked against the batch this call has, which is one — the same thing
    // the repair sweep does when it raises a single drifted article. The
    // ordering that decides which rewrites actually get days is done later, by
    // replenishment, over the whole pool.
    rawScore: 1,
    tasks: [
      {
        kind: 'schedule_topic',
        description: `Rewrite "${subject.title}" and republish it.`,
      },
    ],
  }

  const [ranked] = rankByImpact([draft], config.defaults.scoring.impact)
  if (!ranked) throw new Error('ranking a single refresh request produced nothing')

  const { row, created } = await upsertOpportunity(deps.db, scope, ranked, now)
  if (created) await insertOpportunityTasks(deps.db, row.id, ranked.tasks)

  log.info('refresh_request_admitted', {
    account_id: input.accountId,
    article_id: input.articleId,
    source: input.source,
    opportunity_id: row.id,
    created,
  })

  return { ok: true, opportunityId: row.id, created }
}
