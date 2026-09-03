import type pg from 'pg'
import {
  accountAttribution,
  decideDequeue,
  landingForPass,
  localClock,
  type DequeueBlockReason,
  type IntentClass,
  type Logger,
  type PosthogCapture,
  type SeoDataProvider,
  type SeoLocale,
} from '@sortiva/core'
import {
  accountScope,
  beginGenerating,
  findLatestGateDecisionForTopic,
  findPlannedTopicOnDate,
  findQueryClusterById,
  findTopicOnDate,
  markArticleInReview,
  markTopicInReviewGuarded,
  readAccountSettings,
  readPersona,
  shopifyConnectionState,
  type Db,
  type TopicRow,
} from '@sortiva/db'
import { withAccountLock } from '../runtime/lock'
import { lookupCompletedWork, recordCompletedWork } from '../runtime/ledger'
import { deriveIdempotencyKey, inputVersion } from '../runtime/idempotency'
import { accountLifecycleGate, mayAccountWorkRun } from '../runtime/gate'
import { runtimeLogger } from '../runtime/logging'
import { generateArticle, type GenerateArticleDeps } from './generate-article'

/**
 * One store's day.
 *
 * The whole of the plan's "up to one article per day" lives in this file, and
 * it is enforced by three separate things rather than one, because each covers
 * a case the others cannot:
 *
 *  1. **Only today's topic is offered.** The calendar is asked for a topic on
 *     this exact date. Tomorrow's topic is never pulled forward, and a day that
 *     was skipped stays skipped rather than coming back later as two articles
 *     at once.
 *  2. **The dequeue is a guarded update.** `planned → generating` matches zero
 *     rows for anyone who arrives second, and whoever loses stops rather than
 *     retrying.
 *  3. **The day's work has a key derived from the day and the topic.** A
 *     redelivered job — the queue promises at-least-once, not exactly-once —
 *     finds the key already completed and hands back what the first run
 *     produced, without running anything or spending anything.
 *
 * Everything the account's work does is inside a per-account lock, so a
 * scheduled pass, a manual trigger and a redelivery cannot be inside the
 * pipeline for one store at the same time. Work on different stores stays fully
 * parallel.
 */

/** The step name the day's idempotency key is derived under. Never random; see `deriveIdempotencyKey`. */
export const DAILY_GENERATION_STEP = 'daily_generation'

/** Main §14.7's observability: one event per day that actually produced work. Ids and outcomes only, never article text. */
export const GENERATION_CYCLE_EVENT = 'generation_cycle_completed'

export interface DailyGenerationDeps extends Omit<GenerateArticleDeps, 'db'> {
  readonly db: Db
  /** The shared connection pool — the per-account lock needs a connection of its own. */
  readonly pool: pg.Pool
  readonly seo: SeoDataProvider
  readonly capture?: Pick<PosthogCapture, 'capture'>
  readonly now?: () => Date
  readonly logger?: Logger
}

export type DailyGenerationOutcome =
  /** Nothing ran, and why. */
  | { readonly status: 'skipped'; readonly reason: DequeueBlockReason | 'lost_race' }
  /** This day's work was already done; nothing ran and nothing was spent. */
  | { readonly status: 'already_done'; readonly articleId: string | null; readonly outcome: string }
  /** An article was written and graded. `awaitsReview` says whether the merchant now has to answer. */
  | {
      readonly status: 'generated'
      readonly articleId: string | null
      readonly outcome: string
      readonly awaitsReview: boolean
    }

/** What the ledger keeps for a completed day, so a redelivery can answer without re-running. */
interface DayRecord {
  readonly articleId: string | null
  readonly outcome: string
}

/**
 * Missing lineage stops the run rather than guessing at it. Writing an article
 * from the wrong search term or the wrong language is worse than writing none —
 * main §14.4's "degrade to pause, never to lower quality" applied to a topic
 * whose own inputs cannot be resolved.
 */
export class TopicNotGeneratable extends Error {
  readonly retryable = false
  readonly errorClass = 'topic_not_generatable'

  constructor(readonly topicId: string, detail: string) {
    super(`topic ${topicId} cannot be generated from: ${detail}`)
    this.name = 'TopicNotGeneratable'
  }
}

export async function runDailyGenerationForAccount(
  deps: DailyGenerationDeps,
  accountId: string,
): Promise<DailyGenerationOutcome> {
  const log = deps.logger ?? runtimeLogger()
  const now = (deps.now ?? (() => new Date()))()
  const scope = accountScope(accountId)

  const outcome = await withAccountLock(deps.pool, accountId, async () => {
    const settings = await readAccountSettings(deps.db, scope)
    const today = localClock(now, settings.timezone).date

    // The four reasons to stop, read in the order main §14.5 puts them in: the
    // operator's brakes, then whether the merchant is paid up, then whether
    // they are away, then whether we can still reach their store. The kill
    // switches are read here as well as by the task wrapper — the wrapper is
    // what makes a switch unskippable for every job, and this is what makes the
    // order testable and a direct call safe.
    const [switches, lifecycle, shopify] = await Promise.all([
      mayAccountWorkRun(deps.db, accountId, log),
      accountLifecycleGate(deps.db, accountId),
      shopifyConnectionState(deps.db, scope),
    ])

    // Only a `planned` topic is a dequeue. A topic left `generating` on today's
    // date is a previous attempt that died: it is finished rather than left
    // stranded, but it is not a second dequeue and does not consume a second
    // day.
    const planned = await findPlannedTopicOnDate(deps.db, scope, today)
    const stranded = planned ? undefined : await strandedTopicOn(deps.db, scope, today)

    const decision = decideDequeue({
      switches,
      lifecycle,
      shopify,
      hasPlannedTopicToday: planned !== undefined || stranded !== undefined,
    })

    if (!decision.allowed) {
      log.info('generation_cycle_skipped', {
        account_id: accountId,
        date: today,
        reason: decision.reason,
        ...(decision.flag ? { flag: decision.flag } : {}),
      })
      return { status: 'skipped', reason: decision.reason } as const
    }

    const topic = (planned ?? stranded) as TopicRow

    // Derived from the day and the topic, never random, so the retry of a run
    // arrives at the same key as the run it is retrying.
    const key = deriveIdempotencyKey(
      accountId,
      DAILY_GENERATION_STEP,
      inputVersion({ topicId: topic.id, date: today }),
    )
    const done = await lookupCompletedWork(deps.db, key)
    if (done) {
      const record = (done.outputRef ?? { articleId: null, outcome: 'unknown' }) as DayRecord
      log.info('generation_cycle_already_done', { account_id: accountId, date: today, topic_id: topic.id })
      return { status: 'already_done', articleId: record.articleId, outcome: record.outcome } as const
    }

    if (planned) {
      const claimed = await beginGenerating(deps.db, scope, topic.id, now)
      // Zero rows: a veto or another worker moved this topic between the read
      // and the write. Stop, per invariant 15 — never retry into someone
      // else's transition.
      if (!claimed) {
        log.info('generation_cycle_lost_dequeue_race', { account_id: accountId, topic_id: topic.id })
        return { status: 'skipped', reason: 'lost_race' } as const
      }
    } else {
      log.info('generation_cycle_resuming', { account_id: accountId, topic_id: topic.id, date: today })
    }

    const result = await generateArticle(deps, await generationInputFor(deps.db, scope, accountId, topic))

    let awaitsReview = false
    if (result.outcome === 'graded') {
      const landing = landingForPass(settings.draftReview)
      if (landing.awaitsReview) {
        // Both halves, in this order: the article first, because the calendar
        // entry's state is what the merchant's screen reads and it must never
        // say "waiting for you" about an article that is not.
        await markArticleInReview(deps.db, scope, result.articleId, now)
        await markTopicInReviewGuarded(deps.db, scope, topic.id, now)
        awaitsReview = true
      }
    }

    const record: DayRecord = { articleId: result.articleId, outcome: result.outcome }
    await recordCompletedWork(deps.db, key, record)

    log.info('generation_cycle_complete', {
      account_id: accountId,
      date: today,
      topic_id: topic.id,
      outcome: result.outcome,
      awaits_review: awaitsReview,
    })

    return {
      status: 'generated',
      articleId: result.articleId,
      outcome: result.outcome,
      awaitsReview,
    } as const
  })

  if (outcome.status !== 'skipped') {
    deps.capture?.capture({
      event: GENERATION_CYCLE_EVENT,
      attribution: accountAttribution(accountId),
      properties: { status: outcome.status, outcome: outcome.outcome },
    })
  }

  return outcome
}

/**
 * A topic left in `generating` on today's date — a run that started and never
 * finished. Picking it up is what stops a crash parking a store's day forever:
 * nothing else would ever look at it again, because the dequeue only offers
 * `planned` rows.
 *
 * Safe to adopt because this is inside the account's lock: no other worker can
 * be inside the pipeline for this store.
 */
async function strandedTopicOn(
  db: Db,
  scope: ReturnType<typeof accountScope>,
  date: string,
): Promise<TopicRow | undefined> {
  const topic = await findTopicOnDate(db, scope, date)
  return topic?.state === 'generating' ? topic : undefined
}

/**
 * Everything the pipeline needs about a topic that the topic row does not hold
 * directly: the search cluster it targets, the store's language and country,
 * and the link Gate 1 asked the article to carry where it found a weak existing
 * match.
 */
async function generationInputFor(
  db: Db,
  scope: ReturnType<typeof accountScope>,
  accountId: string,
  topic: TopicRow,
): Promise<{
  accountId: string
  topicId: string
  intentClass: IntentClass
  cluster: { head: string; members: readonly string[] }
  targetKeyword: string
  familyIds: readonly string[]
  locale: SeoLocale
  linkTaskUrl: string | null
}> {
  const persona = await readPersona(db, scope)
  if (!persona) {
    throw new TopicNotGeneratable(topic.id, 'the store has no confirmed profile, so we do not know its language or country')
  }

  const targetKeyword = topic.targetKeyword ?? topic.title
  const clusterRow = topic.keywordCluster
    ? await findQueryClusterById(db, scope, topic.keywordCluster)
    : undefined

  // A topic with no stored cluster still has a head search — its own target
  // keyword. That is the same term the cluster would be named by, so the
  // pipeline gets a one-term cluster rather than nothing.
  const cluster = clusterRow
    ? { head: clusterRow.headQuery, members: clusterRow.memberQueries }
    : { head: targetKeyword, members: [] as readonly string[] }

  return {
    accountId,
    topicId: topic.id,
    intentClass: topic.intentClass,
    cluster,
    targetKeyword,
    familyIds: topic.familyIds,
    locale: { languageCode: persona.language, countryCode: persona.country },
    linkTaskUrl: await linkTaskUrlFor(db, scope, topic.id),
  }
}

/**
 * The existing page Gate 1 told this article to link to, where it admitted the
 * topic on a weak match (main §7.7 step 4). Gate 1 records it on its own
 * decision row and nowhere else, so this is where it is read back. No decision,
 * or an admission with no weak match, means no link task — the ordinary case.
 */
async function linkTaskUrlFor(
  db: Db,
  scope: ReturnType<typeof accountScope>,
  topicId: string,
): Promise<string | null> {
  const decision = await findLatestGateDecisionForTopic(db, scope, topicId, [1])
  const scores = decision?.scoresJson as { linkTask?: { existingUrl?: unknown } } | null | undefined
  const url = scores?.linkTask?.existingUrl
  return typeof url === 'string' && url !== '' ? url : null
}
