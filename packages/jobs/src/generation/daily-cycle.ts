import type pg from 'pg'
import {
  accountAttribution,
  decideDequeue,
  landingForPass,
  publishDayFor,
  type DequeueBlockReason,
  type IntentClass,
  type Logger,
  type NotificationEmitter,
  type PosthogCapture,
  type SeoDataProvider,
  type SeoLocale,
} from '@sortiva/core'
import {
  accountScope,
  beginGenerating,
  findArticleById,
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
import { rules } from '@sortiva/rules'
import { withAccountLock } from '../runtime/lock'
import { lookupCompletedWork, recordCompletedWork } from '../runtime/ledger'
import { accountLifecycleGate, mayAccountWorkRun } from '../runtime/gate'
import { runtimeLogger } from '../runtime/logging'
import { generateArticle, type GenerateArticleDeps } from './generate-article'
import { DAILY_GENERATION_STEP, dailyGenerationKey } from './day-key'
import { sweepStrandedRuns } from './stranded-sweep'

/**
 * One store's day.
 *
 * The whole of the plan's "up to one article per day" lives in this file, and
 * it is enforced by three separate things rather than one, because each covers
 * a case the others cannot:
 *
 *  1. **Only the topic for the day being published is offered.** The calendar
 *     is asked for a topic on that exact date — the date the article will
 *     appear on, which for a store publishing after midnight is the day after
 *     the writing starts. The next day's topic is never pulled forward, and a
 *     day that was skipped stays skipped rather than coming back later as two
 *     articles at once.
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

export { DAILY_GENERATION_STEP }

/** Main §14.7's observability: one event per day that actually produced work. Ids and outcomes only, never article text. */
export const GENERATION_CYCLE_EVENT = 'generation_cycle_completed'

export interface DailyGenerationDeps extends Omit<GenerateArticleDeps, 'db'> {
  readonly db: Db
  /** The shared connection pool — the per-account lock needs a connection of its own. */
  readonly pool: pg.Pool
  readonly seo: SeoDataProvider
  /**
   * The bell. Only used on accounts that asked to see drafts before they
   * publish — without it a draft moves into review and nobody is told, which
   * is what made that setting unusable. Optional so a scenario harness can run
   * the cycle without one; the running product must supply it, and
   * `GenerationTaskDeps` makes that a compile error rather than a silence.
   */
  readonly notifications?: NotificationEmitter
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
    // The day the article is due to *appear*, not the day it is being written.
    // For a store publishing after midnight those are different dates, and the
    // calendar means the first of them: Tuesday's slot is what a reader sees on
    // Tuesday, whatever hour the writing started.
    const publishDate = publishDayFor(
      now,
      settings.timezone,
      rules().defaults.generation.cycle.lead_hours_before_publish_hour,
    )

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

    // Only a `planned` topic is a dequeue. A topic left `generating` on this
    // date is a previous attempt that died: it is finished rather than left
    // stranded, but it is not a second dequeue and does not consume a second
    // day.
    const planned = await findPlannedTopicOnDate(deps.db, scope, publishDate)
    const stranded = planned ? undefined : await strandedTopicOn(deps.db, scope, publishDate)

    const decision = decideDequeue({
      switches,
      lifecycle,
      shopify,
      hasPlannedTopicToday: planned !== undefined || stranded !== undefined,
    })

    // Every reason but "nothing planned today" stops the store's work
    // altogether, and that has to include looking behind it: finishing an
    // interrupted run is still writing an article, and an operator's brake, an
    // unpaid subscription, a merchant on holiday or a store we can no longer
    // reach each say don't. A day with no topic on it is different — it is the
    // ordinary quiet day, and it is exactly when there is room to catch up.
    if (!decision.allowed) {
      log.info('generation_cycle_skipped', {
        account_id: accountId,
        date: publishDate,
        reason: decision.reason,
        ...(decision.flag ? { flag: decision.flag } : {}),
      })
      if (decision.reason !== 'no_topic_today') return { status: 'skipped', reason: decision.reason } as const
    }

    const today = decision.allowed
      ? await runTodaysTopic(deps, {
          scope,
          accountId,
          settings,
          publishDate,
          topic: (planned ?? stranded) as TopicRow,
          isDequeue: planned !== undefined,
          now,
          log,
        })
      : ({ status: 'skipped', reason: decision.reason } as const)

    // Then, and only then, the days behind this one. Today's article is what
    // the store is owed today; recovering an older one can wait a pass, and a
    // recovery that fails must never be what stops today going out.
    await sweepStrandedRuns({
      db: deps.db,
      scope,
      accountId,
      publishDate,
      now,
      log,
      finish: (topic) =>
        runStrandedTopic(deps, { scope, accountId, settings, topic, now, log }),
    })

    return today
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

/** Everything one topic's run needs that is the same whether it is today's or a day being caught up. */
interface TopicRunContext {
  readonly scope: ReturnType<typeof accountScope>
  readonly accountId: string
  readonly settings: Awaited<ReturnType<typeof readAccountSettings>>
  readonly topic: TopicRow
  readonly now: Date
  readonly log: Logger
}

/**
 * The store's own day: claim the topic if it is a fresh one, then write it.
 *
 * The claim is what makes "at most one article a day" true under a queue that
 * delivers at least once — a second dispatch matches no rows and stops. A topic
 * already `generating` on this date is a previous attempt that died earlier
 * today; it is finished rather than claimed again, and it does not consume a
 * second day.
 */
async function runTodaysTopic(
  deps: DailyGenerationDeps,
  ctx: TopicRunContext & { readonly publishDate: string; readonly isDequeue: boolean },
): Promise<DailyGenerationOutcome> {
  const { accountId, log, now, scope, topic } = ctx

  const key = dailyGenerationKey(accountId, topic.id, topic.scheduledDate)
  const done = await lookupCompletedWork(deps.db, key)
  if (done) {
    const record = (done.outputRef ?? { articleId: null, outcome: 'unknown' }) as DayRecord
    log.info('generation_cycle_already_done', { account_id: accountId, date: ctx.publishDate, topic_id: topic.id })
    return { status: 'already_done', articleId: record.articleId, outcome: record.outcome }
  }

  if (ctx.isDequeue) {
    const claimed = await beginGenerating(deps.db, scope, topic.id, now)
    // Zero rows: a veto or another worker moved this topic between the read
    // and the write. Stop, per invariant 15 — never retry into someone
    // else's transition.
    if (!claimed) {
      log.info('generation_cycle_lost_dequeue_race', { account_id: accountId, topic_id: topic.id })
      return { status: 'skipped', reason: 'lost_race' }
    }
  } else {
    log.info('generation_cycle_resuming', { account_id: accountId, topic_id: topic.id, date: ctx.publishDate })
  }

  const landed = await generateAndLand(deps, ctx, key)

  log.info('generation_cycle_complete', {
    account_id: accountId,
    date: ctx.publishDate,
    topic_id: topic.id,
    outcome: landed.outcome,
    awaits_review: landed.awaitsReview,
  })

  return {
    status: 'generated',
    articleId: landed.articleId,
    outcome: landed.outcome,
    awaitsReview: landed.awaitsReview,
  }
}

/**
 * A day being caught up: the same pipeline, on a topic already flipped to
 * `generating` by the attempt that died. There is nothing to claim — the claim
 * happened on the day itself — and the article stays attached to its own past
 * date, so no calendar day is handed an article it was not scheduled for.
 */
async function runStrandedTopic(
  deps: DailyGenerationDeps,
  ctx: TopicRunContext,
): Promise<{ articleId: string | null; outcome: string }> {
  const key = dailyGenerationKey(ctx.accountId, ctx.topic.id, ctx.topic.scheduledDate)
  const landed = await generateAndLand(deps, ctx, key)
  ctx.log.info('generation_stranded_finished', {
    account_id: ctx.accountId,
    topic_id: ctx.topic.id,
    date: ctx.topic.scheduledDate,
    outcome: landed.outcome,
    awaits_review: landed.awaitsReview,
  })
  return { articleId: landed.articleId, outcome: landed.outcome }
}

/**
 * Write the article, put it where the store's own review setting says it goes,
 * and record the day as done.
 *
 * The ledger entry is last and covers the whole of it, so a crash anywhere
 * before it leaves the day open to be finished rather than recorded as work
 * that never happened.
 */
async function generateAndLand(
  deps: DailyGenerationDeps,
  ctx: TopicRunContext,
  key: string,
): Promise<{ articleId: string | null; outcome: string; awaitsReview: boolean }> {
  const { accountId, log, now, scope, topic } = ctx
  const result = await generateArticle(deps, await generationInputFor(deps.db, scope, accountId, topic))

  let awaitsReview = false
  if (result.outcome === 'graded') {
    const landing = landingForPass(ctx.settings.draftReview)
    if (landing.awaitsReview) {
      // Both halves, in this order: the article first, because the calendar
      // entry's state is what the merchant's screen reads and it must never
      // say "waiting for you" about an article that is not.
      const moved = await markArticleInReview(deps.db, scope, result.articleId, now)
      await markTopicInReviewGuarded(deps.db, scope, topic.id, now)
      awaitsReview = true
      await announceDraftForReview(deps, accountId, result.articleId, moved !== undefined, log)
    }
  }

  const record: DayRecord = { articleId: result.articleId, outcome: result.outcome }
  await recordCompletedWork(deps.db, key, record)

  return { articleId: result.articleId, outcome: result.outcome, awaitsReview }
}

/**
 * "Your draft is waiting."
 *
 * Draft review is a setting a merchant switches on to have the last word
 * before anything appears on their site. Switching it on used to mean the
 * day's article simply stopped appearing, with nothing sent and nothing said;
 * this is the sending.
 *
 * Two things it is careful about, and each is a way of telling somebody
 * something untrue:
 *
 *  - **It never announces a draft that is not waiting.** The move into review
 *    is a guarded update, and it matches nothing when the merchant vetoed the
 *    topic while the article was being written — the race main §8.7 describes.
 *    So when the update matched nothing, the article is read back, and only an
 *    article actually sitting in review is announced. A discarded one is not.
 *  - **It announces the same draft once.** The key is the article's own id, so
 *    a redelivered job — and a retry of a run that died between the move and
 *    this call, which finds the article already in review — writes no second
 *    row and sends no second email.
 */
async function announceDraftForReview(
  deps: DailyGenerationDeps,
  accountId: string,
  articleId: string,
  moved: boolean,
  log: Logger,
): Promise<void> {
  if (!deps.notifications) {
    log.warn('draft_ready_notification_not_configured', { account_id: accountId, article_id: articleId })
    return
  }

  if (!moved) {
    const current = await findArticleById(deps.db, accountScope(accountId), articleId)
    if (current?.state !== 'in_review') return
  }

  await deps.notifications.emit(
    'draft_ready_for_review',
    { article_id: articleId },
    articleId,
    accountAttribution(accountId),
  )
}

/**
 * A topic left in `generating` on the day being published — a run that started
 * and never finished. Picking it up is what stops a crash parking a store's day forever:
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
