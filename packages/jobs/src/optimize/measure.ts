import {
  accountAttribution,
  normalisePageUrl,
  opportunityOutcomeMeasured,
  optimizeOutcomeJson,
  optimizeOutcomeLabel,
  storeMedianImpressions,
  toIsoDate,
  type Logger,
  type OptimizeOutcomeRecord,
  type OptimizeUnmeasurableReason,
  type OptimizeWindowTotals,
  type PosthogCapture,
} from '@sortiva/core'
import {
  accountScope,
  findArticleById,
  findGscConnForAccount,
  findOpportunityById,
  gscPageTotals,
  latestGscDay,
  listStorePages,
  recordOpportunityOutcome,
  type AccountScope,
  type Db,
} from '@sortiva/db'
import { rules } from '@sortiva/rules'
import { runtimeLogger } from '../runtime/logging'

/**
 * Looking again, four weeks after a merchant told us they made the changes we
 * suggested for one of their pages.
 *
 * The promise is made at the moment they press "mark as applied": the product
 * says it will come back and say what changed. This is the coming back. Until
 * this existed the promise was made and nothing kept it — the work was queued
 * under a name no running code answered to.
 *
 * **Four weeks is a floor, not a formality.** Rankings take weeks to settle,
 * and a verdict read early measures noise and then teaches the planner from it.
 * A job that arrives early is put back for the day it is actually due rather
 * than answered.
 *
 * **What we cannot see, we do not judge.** A page taken down, a store whose
 * search history has not caught up, a store with no Search Console at all: each
 * writes a record saying which of those it was, and no verdict. The merchant's
 * screen then shows no result rather than a bad one, which is the whole point
 * — somebody who did the work and later retired the page must not be told
 * their work caused a collapse.
 */

export interface MeasureOpportunityOutcomeDeps {
  readonly db: Db
  readonly capture?: PosthogCapture
  readonly now?: () => Date
  readonly logger?: Logger
}

export interface MeasureOpportunityOutcomeInput {
  readonly accountId: string
  readonly opportunityId: string
}

export type MeasureOpportunityOutcome =
  /** A verdict was written. */
  | { readonly status: 'measured'; readonly record: OptimizeOutcomeRecord }
  /** Looked, and recorded why there is nothing to say. Also final: nothing looks again. */
  | { readonly status: 'unmeasurable'; readonly record: OptimizeOutcomeRecord }
  /**
   * Not yet. `retryAt` is when it is worth asking again — either the day the
   * four weeks are up, or a day from now while Search Console catches up.
   */
  | { readonly status: 'too_early'; readonly retryAt: Date }
  | { readonly status: 'awaiting_search_data'; readonly retryAt: Date }
  /** Nothing to measure: the row is gone, or was never an OPTIMIZE, or somebody already measured it. */
  | { readonly status: 'skipped'; readonly reason: string }

const DAY_MS = 24 * 60 * 60 * 1000

/** Inclusive `YYYY-MM-DD` bounds of `days` whole days, ending `endOffset` days from `anchor`. */
function windowEnding(anchor: Date, endOffset: number, days: number): { startDate: string; endDate: string } {
  const end = new Date(anchor.getTime() + endOffset * DAY_MS)
  const start = new Date(end.getTime() - (days - 1) * DAY_MS)
  return { startDate: toIsoDate(start), endDate: toIsoDate(end) }
}

function totalsFor(
  rows: readonly { key: string; clicks: number; impressions: number; position: number | null }[],
  pageUrl: string,
): OptimizeWindowTotals {
  const wanted = normalisePageUrl(pageUrl)
  const row = rows.find((candidate) => normalisePageUrl(candidate.key) === wanted)
  // A page Search Console never mentioned was shown zero times, which is a
  // reading rather than a gap: Google reports every page it showed.
  return row
    ? { clicks: row.clicks, impressions: row.impressions, position: row.position }
    : { clicks: 0, impressions: 0, position: null }
}

async function pageIsOverridePublished(
  db: Db,
  scope: AccountScope,
  articleId: string | null,
): Promise<boolean> {
  if (!articleId) return false
  const article = await findArticleById(db, scope, articleId)
  return article?.publishedViaOverride === true
}

export async function measureOpportunityOutcome(
  deps: MeasureOpportunityOutcomeDeps,
  input: MeasureOpportunityOutcomeInput,
): Promise<MeasureOpportunityOutcome> {
  const log = deps.logger ?? runtimeLogger()
  const now = (deps.now ?? (() => new Date()))()
  const scope = accountScope(input.accountId)
  const config = rules().defaults.learning.outcomes

  const opportunity = await findOpportunityById(deps.db, scope, input.opportunityId)
  if (!opportunity) return { status: 'skipped', reason: 'opportunity_gone' }
  if (opportunity.recommendedAction !== 'optimize') {
    // REFRESH and FIX outcomes are anchored differently and measured against
    // different numbers; each is its own card. Measuring one of them with this
    // page comparison would put a wrong verdict on the row rather than none.
    return { status: 'skipped', reason: 'not_an_optimize' }
  }
  if (opportunity.outcomeMeasuredAt) return { status: 'skipped', reason: 'already_measured' }

  const pageUrl = opportunity.entityRef
  const unmeasurable = (reason: OptimizeUnmeasurableReason): OptimizeOutcomeRecord => ({
    measured: false,
    action: 'optimize',
    reason,
    pageUrl,
    measuredAt: now.toISOString(),
  })

  const write = async (record: OptimizeOutcomeRecord): Promise<MeasureOpportunityOutcome> => {
    const written = await recordOpportunityOutcome(
      deps.db,
      scope,
      input.opportunityId,
      optimizeOutcomeJson(record),
      now,
    )
    if (!written) return { status: 'skipped', reason: 'guard_lost' }
    log.info('opportunity_outcome_measured', {
      account_id: input.accountId,
      opportunity_id: input.opportunityId,
      measured: record.measured,
      ...(record.measured ? { label: record.label } : { reason: record.reason }),
    })
    if (record.measured && deps.capture) {
      deps.capture.capture(
        opportunityOutcomeMeasured(accountAttribution(input.accountId), {
          actionType: 'optimize',
          label: record.label,
        }),
      )
    }
    return record.measured
      ? { status: 'measured', record }
      : { status: 'unmeasurable', record }
  }

  // A row that was never marked applied has no moment to count four weeks from.
  // The spec's own name for that state, so a later pattern pass can tell it
  // apart from a page we simply could not read.
  if (!opportunity.appliedAt) return write(unmeasurable('not_applied'))

  const appliedAt = opportunity.appliedAt
  const dueAt = new Date(appliedAt.getTime() + config.maturity_days * DAY_MS)
  if (now < dueAt) return { status: 'too_early', retryAt: dueAt }

  const pages = await listStorePages(deps.db, scope)
  const wanted = normalisePageUrl(pageUrl)
  const page = pages.find((row) => normalisePageUrl(row.url) === wanted)
  // The apply handler already declines to book a measurement for a page that
  // had gone by then. This is the other half of the same rule: a page can be
  // taken down at any point during the four weeks a measurement is waiting,
  // and nothing in the request path could have known. A page we hold no row
  // for at all gets the same answer, for the same reason — there is nothing
  // here to measure either way.
  if (!page || page.status !== 'live') return write(unmeasurable('page_no_longer_in_store'))

  // Published past the quality gate on the merchant's own insistence. Those
  // articles are kept out of everything the product learns from and out of any
  // claim it makes about how its work performs, so this looks at the numbers
  // for one and records none of them.
  if (await pageIsOverridePublished(deps.db, scope, page.articleId)) {
    return write(unmeasurable('published_via_override'))
  }

  const connection = await findGscConnForAccount(deps.db, scope)
  if (!connection || connection.property === '') {
    // No search data now and none coming: the comparison this makes does not
    // exist for this store. Recorded once rather than retried weekly.
    return write(unmeasurable('search_console_not_connected'))
  }

  // The apply day itself belongs to neither window: part of it is before the
  // merchant's edit and part after.
  const afterWindow = windowEnding(appliedAt, config.window_days, config.window_days)
  const beforeWindow = windowEnding(appliedAt, -1, config.window_days)

  const latest = await latestGscDay(deps.db, scope)
  if (!latest || latest < afterWindow.endDate) {
    // Comparing a part-finished four weeks against a whole one manufactures a
    // decline out of nothing but the calendar, which is exactly the false
    // collapse this job exists not to record. So wait for the sync — but not
    // for ever: a grant that dies, or a sync that never runs again, would
    // otherwise leave this job re-queueing itself weekly and permanently.
    const giveUpAt = new Date(dueAt.getTime() + config.window_days * DAY_MS)
    if (now < giveUpAt) {
      return { status: 'awaiting_search_data', retryAt: new Date(now.getTime() + DAY_MS) }
    }
    return write(unmeasurable('search_data_incomplete'))
  }

  const [beforeRows, afterRows] = await Promise.all([
    gscPageTotals(deps.db, scope, beforeWindow),
    gscPageTotals(deps.db, scope, afterWindow),
  ])

  const before = totalsFor(beforeRows, page.url)
  const after = totalsFor(afterRows, page.url)
  if (before.impressions === 0) {
    // Nothing was shown in the four weeks before the work, so every comparison
    // below divides by nothing. A page going from invisible to visible is real
    // and good, and this deliberately does not call it a win: with no baseline
    // there is no way to tell it from a page that was simply not indexed yet.
    return write(unmeasurable('no_baseline'))
  }

  // Only pages the inventory holds count towards the store's own middle. A
  // page Search Console reports and we have no row for is one nothing here
  // could act on, and letting it move the yardstick would change the bar for
  // every page that can be acted on.
  const known = new Set(pages.map((row) => normalisePageUrl(row.url)))
  const storeMedian = storeMedianImpressions(
    afterRows
      .filter((row) => known.has(normalisePageUrl(row.key)))
      .map((row) => ({ clicks: row.clicks, impressions: row.impressions, position: row.position })),
  )

  const label = optimizeOutcomeLabel({
    before,
    after,
    storeMedian,
    config: config.optimize,
  })

  return write({
    measured: true,
    action: 'optimize',
    label,
    pageUrl: page.url,
    beforeWindow,
    afterWindow,
    before,
    after,
    storeMedianImpressions: storeMedian,
    measuredAt: now.toISOString(),
  })
}
