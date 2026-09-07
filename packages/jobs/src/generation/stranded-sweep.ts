import { triageStrandedRuns, type Logger, type StrandedRun } from '@sortiva/core'
import {
  findArticleByTopic,
  strandedGeneratingTopicsBefore,
  type AccountScope,
  type Db,
  type TopicRow,
} from '@sortiva/db'
import { deadLetter } from '../runtime/dlq'
import { classify } from '../runtime/errors'
import { lookupCompletedWork, recordCompletedWork } from '../runtime/ledger'
import { DAILY_GENERATION_STEP, dailyGenerationKey } from './day-key'

/**
 * The recovery pass for a day whose writing was interrupted and never came
 * back for.
 *
 * The daily cycle already picks up its own unfinished work, but only while it
 * is still the same day where the store is. A worker killed at 23:50 and
 * restarted at 00:05 finds nothing to do: the run it was retrying belongs to a
 * date the new day never asks about. The article was written, nothing graded
 * it, and the queue recorded the retry as a success — no error, no alert, and a
 * draft the merchant paid for that never appears.
 *
 * So every store's daily pass now also looks behind it. What it does with what
 * it finds is deliberately asymmetric:
 *
 *  - **One is finished** — the one with the most already-paid-for work behind
 *    it. Finishing costs the checks rather than the writer.
 *  - **The rest are given up on, in writing.** A dead-letter entry per
 *    abandoned day is the whole point: an operator sees that a store lost a
 *    day and why, instead of nobody seeing anything.
 *
 * **Why not finish all of them.** Several days' articles finished at once
 * become several days' articles delivered at once, and the calendar's rule is
 * that a quiet day stays quiet rather than coming back later as a burst.
 * Nothing here moves a topic to a different date, adds a calendar entry, or
 * hands a day an article it was not scheduled for: a finished run keeps its own
 * past date, and delivery still takes one article a day.
 *
 * Both halves are recorded under the day's own idempotency key — the same key
 * the killed run would have recorded — so a store is never given up on twice,
 * and a day already resolved is never reopened.
 */

export interface StrandedSweepArgs {
  readonly db: Db
  readonly scope: AccountScope
  readonly accountId: string
  /** The date the store's *current* day publishes on. Anything before it is behind. */
  readonly publishDate: string
  readonly now: Date
  readonly log: Logger
  /**
   * Runs the rest of the pipeline for one stranded topic and lands it, exactly
   * as the day's own pass would have. Supplied by the caller so this file owns
   * the choosing and the giving up, and the daily cycle keeps the pipeline.
   */
  readonly finish: (topic: TopicRow) => Promise<{ articleId: string | null; outcome: string }>
}

export interface StrandedSweepResult {
  /** The topic that was carried to a verdict, if there was one to carry. */
  readonly finished: { readonly topicId: string; readonly outcome: string } | null
  /** The topics given up on, with a dead letter each. */
  readonly abandoned: readonly string[]
}

/** The outcome stored against an abandoned day, so nothing reopens it. */
const ABANDONED_OUTCOME = 'abandoned_stranded'

/** The slug the alert over the dead-letter queue groups these by. */
const ABANDONED_ERROR_CLASS = 'generation_run_stranded'

export async function sweepStrandedRuns(args: StrandedSweepArgs): Promise<StrandedSweepResult> {
  const candidates = await strandedGeneratingTopicsBefore(args.db, args.scope, args.publishDate)
  if (candidates.length === 0) return { finished: null, abandoned: [] }

  const open: { topic: TopicRow; run: StrandedRun }[] = []
  for (const topic of candidates) {
    // A day this sweep already resolved — finished or given up on — keeps its
    // ledger entry for ever. Without this check an abandoned day would be
    // rediscovered every morning, dead-lettered again, and would go on winning
    // the one place the sweep has for finishing something.
    if (await lookupCompletedWork(args.db, dailyGenerationKey(args.accountId, topic.id, topic.scheduledDate))) continue
    const article = await findArticleByTopic(args.db, args.scope, topic.id)
    open.push({
      topic,
      run: {
        topicId: topic.id,
        scheduledDate: topic.scheduledDate,
        articleId: article?.id ?? null,
        // Only a draft is adoptable by the pipeline, so only a draft counts as
        // work the finish would not have to pay for again.
        hasStoredDraft: article?.state === 'draft' && article.bodyJson !== null,
      },
    })
  }
  if (open.length === 0) return { finished: null, abandoned: [] }

  const byTopic = new Map(open.map((entry) => [entry.run.topicId, entry.topic]))
  const triage = triageStrandedRuns(open.map((entry) => entry.run))

  // The giving-up happens first. It spends nothing and it is the half that must
  // not be skipped: if finishing then fails, an operator has still been told
  // about every day this store lost.
  const abandoned: string[] = []
  for (const run of triage.abandon) {
    await abandon(args, run, 'another interrupted run for this store was further along and was finished instead')
    abandoned.push(run.topicId)
  }

  if (!triage.finish) return { finished: null, abandoned }

  const chosen = byTopic.get(triage.finish.topicId) as TopicRow
  args.log.info('generation_stranded_finishing', {
    account_id: args.accountId,
    topic_id: chosen.id,
    date: chosen.scheduledDate,
    stranded_behind: abandoned.length,
  })

  try {
    const result = await args.finish(chosen)
    return { finished: { topicId: chosen.id, outcome: result.outcome }, abandoned }
  } catch (error) {
    // A failure that another attempt could fix is left to another attempt: the
    // job's own retry, and the store's next daily pass, will find this run
    // stranded again. A failure nothing will fix — a topic whose own inputs
    // cannot be resolved — is a day this store has lost, and saying so is the
    // whole point of the sweep.
    const classified = classify(error)
    if (classified.retryable) throw error
    await abandon(args, triage.finish, classified.message, classified.errorClass)
    return { finished: null, abandoned: [...abandoned, triage.finish.topicId] }
  }
}

/**
 * One day given up on: a dead-letter entry so a person is told, and a ledger
 * entry so it is never given up on a second time.
 *
 * The entry carries the day's own idempotency key, which is what ties it back
 * to the run that died and to anything that run recorded.
 */
async function abandon(
  args: StrandedSweepArgs,
  run: StrandedRun,
  detail: string,
  errorClass: string = ABANDONED_ERROR_CLASS,
): Promise<void> {
  const key = dailyGenerationKey(args.accountId, run.topicId, run.scheduledDate)

  await deadLetter(args.db, {
    accountId: args.accountId,
    step: DAILY_GENERATION_STEP,
    idempotencyKey: key,
    errorClass,
    lastError:
      `the article for ${run.scheduledDate} was started and never finished — the worker writing it stopped ` +
      `before the store's own midnight, and the day is now behind us. ${detail}.`,
    attempts: 1,
    inputRefs: {
      topic_id: run.topicId,
      scheduled_date: run.scheduledDate,
      article_id: run.articleId,
      had_stored_draft: run.hasStoredDraft,
    },
    firstFailedAt: args.now,
  })

  await recordCompletedWork(args.db, key, { articleId: run.articleId, outcome: ABANDONED_OUTCOME })

  args.log.error('generation_stranded_abandoned', {
    account_id: args.accountId,
    topic_id: run.topicId,
    date: run.scheduledDate,
    article_id: run.articleId,
    error_class: errorClass,
  })
}
