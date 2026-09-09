import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { silentLogger } from '@sortiva/core'
import {
  accountScope,
  findOpportunityById,
  insertMinimalOpportunity,
  markOpportunityApplied,
  saveGscGrant,
  selectGscProperty,
  upsertGscDaily,
  upsertStorePages,
  type Db,
} from '@sortiva/db'
import {
  databaseAvailable,
  insertAccount,
  setupTestDb,
  truncateAll,
  type TestDb,
} from '@sortiva/db/testing'
import { MockPosthogCapture } from '@sortiva/providers'
import { rules } from '@sortiva/rules'
import { clearTasks, registeredTaskNames, taskList } from '../runtime/tasks'
import { resetKillSwitchReader } from '../runtime/gate'
import { ACCOUNT_LOCK_NAMESPACE } from '../runtime/lock'
import { measureOpportunityOutcome } from './measure'
import { OPPORTUNITY_OUTCOME_MEASURE_TASK } from './queue'
import { registerOptimizeTasks, resetOptimizeTaskRegistration } from './tasks'

/**
 * The promise the product makes when a merchant presses "mark as applied": we
 * will look at this page again in four weeks and tell you what changed.
 *
 * Until this job existed the promise was made and nothing kept it — the work
 * was queued under a name no running code answered to, so the row sat with its
 * due date for ever and the merchant's Performance table showed a dash.
 *
 * The cases below are mostly about the two answers that are easy to confuse.
 * A page that went away, a store whose Search Console has not caught up, an
 * article published past the quality gate: each of those is "we cannot measure
 * this", and each of them, measured anyway, would come out as "this made things
 * worse". The strongest cases here plant numbers that *would* produce a decline
 * and prove the row still carries no verdict, so what is being tested is the
 * refusal rather than the arithmetic happening to agree.
 */

const available = await databaseAvailable()

const OUTCOMES = rules().defaults.learning.outcomes
const DAY_MS = 24 * 60 * 60 * 1000

const PAGE = 'https://shop.example/collections/hiking-boots'
const APPLIED_AT = new Date('2026-08-01T09:00:00.000Z')
/** The day the four weeks are up, to the millisecond. */
const DUE_AT = new Date(APPLIED_AT.getTime() + OUTCOMES.maturity_days * DAY_MS)
const AT_MATURITY = new Date(DUE_AT.getTime() + 60_000)

let harness: TestDb
let db: Db
let accountId: string
let capture: MockPosthogCapture

beforeAll(async () => {
  if (!available) {
    throw new Error('Postgres is not reachable. Run `pnpm db:up` before the test suite.')
  }
  harness = await setupTestDb('opportunity_outcome')
  db = harness.db
}, 60_000)

afterAll(async () => {
  await harness?.close()
})

beforeEach(async () => {
  await truncateAll(harness.pool)
  clearTasks()
  resetOptimizeTaskRegistration()
  capture = new MockPosthogCapture()
  accountId = await insertAccount(harness.pool, 'outcome@example.com')
})

afterEach(() => {
  clearTasks()
  resetOptimizeTaskRegistration()
  resetKillSwitchReader()
})

function scope() {
  return accountScope(accountId)
}

function isoDay(offsetDaysFromApply: number): string {
  return new Date(APPLIED_AT.getTime() + offsetDaysFromApply * DAY_MS).toISOString().slice(0, 10)
}

/** The store's search history: one row per day per page, so the two windows sum to whole numbers. */
async function seedSearchHistory(
  days: readonly { offset: number; page: string; clicks: number; impressions: number; position: number }[],
): Promise<void> {
  await upsertGscDaily(
    db,
    scope(),
    days.map((day) => ({
      date: isoDay(day.offset),
      page: day.page,
      clicks: day.clicks,
      impressions: day.impressions,
      position: day.position,
    })),
  )
}

/**
 * Flat daily figures across one whole window, which makes the totals easy to
 * reason about: `perDay × window_days`.
 */
function windowDays(
  page: string,
  side: 'before' | 'after',
  perDay: { clicks: number; impressions: number; position: number },
) {
  // The apply day itself belongs to neither window: half of it is before the
  // merchant's edit and half after.
  const first = side === 'before' ? -OUTCOMES.window_days : 1
  return Array.from({ length: OUTCOMES.window_days }, (_, n) => ({
    offset: first + n,
    page,
    ...perDay,
  }))
}

async function connectSearchConsole(): Promise<void> {
  await saveGscGrant(db, scope(), { tokens: 'encrypted' })
  await selectGscProperty(db, scope(), {
    property: 'sc-domain:shop.example',
    connectedAt: new Date('2026-06-01T00:00:00.000Z'),
  })
}

async function seedLivePage(url: string = PAGE): Promise<void> {
  await upsertStorePages(db, scope(), [
    {
      url,
      pageType: 'collection',
      handle: 'hiking-boots',
      shopifyId: '1',
      title: 'Hiking boots',
      seoTitle: null,
      seoDescription: null,
      headings: [],
      bodyHtml: null,
      outboundInternalLinks: [],
      familyIds: [],
      checksum: 'c1',
    },
  ])
}

/** An OPTIMIZE the merchant has marked applied — the only kind of row this job ever measures. */
async function seedAppliedOptimize(url: string = PAGE): Promise<string> {
  const row = await insertMinimalOpportunity(
    db,
    scope(),
    {
      signalType: 'striking_distance',
      entityType: 'url',
      entityRef: url,
      evidenceJson: {},
      recommendedAction: 'optimize',
      status: 'accepted',
      reasonTemplateKey: 'striking_distance.optimize',
      reasonParams: {},
      limitedIntelligence: false,
      rulesVersion: 'test',
    },
    APPLIED_AT,
  )
  const applied = await markOpportunityApplied(db, scope(), row.id, APPLIED_AT)
  if (!applied) throw new Error('the fixture failed to mark the opportunity applied')
  return row.id
}

/**
 * Numbers that make this page a clear decline: impressions cut to a fifth and
 * the ranking six places worse. Planted wherever a case needs to prove the job
 * refuses to render a verdict — if the refusal broke, this is what would appear
 * on the merchant's screen.
 */
async function seedCollapse(url: string = PAGE): Promise<void> {
  await seedSearchHistory([
    ...windowDays(url, 'before', { clicks: 4, impressions: 100, position: 8 }),
    ...windowDays(url, 'after', { clicks: 1, impressions: 15, position: 14 }),
  ])
}

function deps() {
  return { db, capture, logger: silentLogger, now: () => AT_MATURITY }
}

describe.skipIf(!available)('four weeks after the merchant said they did the work', () => {
  it('writes the verdict, the numbers and the event', async () => {
    await connectSearchConsole()
    await seedLivePage()
    const opportunityId = await seedAppliedOptimize()
    await seedSearchHistory([
      // Flat 4% click-through either side, so the ranking is the only thing
      // that moved: 11.4 to 8.1 clears the two-place bar.
      ...windowDays(PAGE, 'before', { clicks: 4, impressions: 100, position: 11.4 }),
      ...windowDays(PAGE, 'after', { clicks: 5, impressions: 125, position: 8.1 }),
      // A second, quieter page, so the store has a median to be measured
      // against rather than being its own only page.
      ...windowDays('https://shop.example/collections/socks', 'after', {
        clicks: 1,
        impressions: 20,
        position: 30,
      }),
    ])
    await upsertStorePages(db, scope(), [
      {
        url: 'https://shop.example/collections/socks',
        pageType: 'collection',
        handle: 'socks',
        shopifyId: '2',
        title: 'Socks',
        seoTitle: null,
        seoDescription: null,
        headings: [],
        bodyHtml: null,
        outboundInternalLinks: [],
        familyIds: [],
        checksum: 'c2',
      },
    ])

    const outcome = await measureOpportunityOutcome(deps(), { accountId, opportunityId })
    expect(outcome.status).toBe('measured')

    const row = await findOpportunityById(db, scope(), opportunityId)
    const stored = row?.outcomeJson as Record<string, unknown>
    // The three top-level fields are what the opportunity drawer and the
    // Performance table already read; the record beside them carries the rest.
    expect(stored).toMatchObject({
      label: 'improved',
      before: 4 * OUTCOMES.window_days,
      after: 5 * OUTCOMES.window_days,
    })
    expect(row?.outcomeMeasuredAt).toEqual(AT_MATURITY)

    const measurement = stored['measurement'] as Record<string, unknown>
    expect(measurement).toMatchObject({ measured: true, action: 'optimize', label: 'improved' })
    // The two windows are whole and adjacent to the apply, and the apply day
    // itself is in neither.
    expect(measurement['beforeWindow']).toEqual({ startDate: isoDay(-28), endDate: isoDay(-1) })
    expect(measurement['afterWindow']).toEqual({ startDate: isoDay(1), endDate: isoDay(28) })

    // The double runs the live wrapper's own event table, so this also proves
    // the event is declared: an undeclared name is dropped before the wire.
    const sent = capture.of('opportunity_outcome_measured')
    expect(sent).toHaveLength(1)
    expect(sent[0]?.properties).toMatchObject({ action_type: 'optimize', label: 'improved' })
    // Nothing of the store's own goes with it — no address, no click counts.
    expect(JSON.stringify(sent[0]?.properties)).not.toContain('shop.example')
  })

  it('does not erase a repair log already written on the same row', async () => {
    await connectSearchConsole()
    await seedLivePage()
    const opportunityId = await seedAppliedOptimize()
    await seedSearchHistory([
      ...windowDays(PAGE, 'before', { clicks: 4, impressions: 100, position: 11.4 }),
      ...windowDays(PAGE, 'after', { clicks: 5, impressions: 125, position: 8.1 }),
    ])
    // A drift repair got to this row first and wrote its own record under its
    // own key. One opportunity, two things to say about it.
    await harness.pool.query(
      `UPDATE opportunities SET outcome_json = $1::jsonb WHERE id = $2`,
      [JSON.stringify({ repair: { kind: 'product_deleted', references: [] } }), opportunityId],
    )

    await measureOpportunityOutcome(deps(), { accountId, opportunityId })

    const row = await findOpportunityById(db, scope(), opportunityId)
    const stored = row?.outcomeJson as Record<string, unknown>
    // Merged by the database rather than read-modify-written, so a repair
    // committing between our read and our write could not be lost either.
    expect(stored['repair']).toMatchObject({ kind: 'product_deleted' })
    expect(stored['measurement']).toMatchObject({ measured: true })
  })

  it('says nothing at all before the four weeks are up', async () => {
    await connectSearchConsole()
    await seedLivePage()
    const opportunityId = await seedAppliedOptimize()
    await seedCollapse()

    const dayEarly = new Date(DUE_AT.getTime() - DAY_MS)
    const outcome = await measureOpportunityOutcome(
      { ...deps(), now: () => dayEarly },
      { accountId, opportunityId },
    )

    expect(outcome).toEqual({ status: 'too_early', retryAt: DUE_AT })
    const row = await findOpportunityById(db, scope(), opportunityId)
    // Not a "pending" verdict written early and corrected later: nothing at all.
    expect(row?.outcomeJson).toBeNull()
    expect(row?.outcomeMeasuredAt).toBeNull()
  })
})

describe.skipIf(!available)('a page that is no longer there', () => {
  it('stays unmeasured rather than being recorded as a collapse', async () => {
    await connectSearchConsole()
    await seedLivePage()
    const opportunityId = await seedAppliedOptimize()
    await seedCollapse()
    // The merchant retired the page some time in the four weeks — after the
    // apply handler had already checked and booked the measurement.
    await harness.pool.query(`UPDATE store_pages SET status = 'gone' WHERE account_id = $1`, [
      accountId,
    ])

    const outcome = await measureOpportunityOutcome(deps(), { accountId, opportunityId })
    expect(outcome.status).toBe('unmeasurable')

    const row = await findOpportunityById(db, scope(), opportunityId)
    const stored = row?.outcomeJson as Record<string, unknown>
    expect(stored['measurement']).toMatchObject({
      measured: false,
      reason: 'page_no_longer_in_store',
    })
    // The point of the case. The planted history is a five-fold impressions
    // drop and a six-place ranking fall, which is what the merchant would be
    // shown if this row carried a verdict — and it carries none.
    expect(stored).not.toHaveProperty('label')
    expect(stored).not.toHaveProperty('before')
    expect(stored).not.toHaveProperty('after')
    expect(capture.of('opportunity_outcome_measured')).toHaveLength(0)
  })

  it('gives the same answer for an address the inventory never held', async () => {
    await connectSearchConsole()
    const opportunityId = await seedAppliedOptimize('https://shop.example/collections/gone')
    await seedCollapse('https://shop.example/collections/gone')

    const outcome = await measureOpportunityOutcome(deps(), { accountId, opportunityId })
    expect(outcome.status).toBe('unmeasurable')
    const row = await findOpportunityById(db, scope(), opportunityId)
    expect((row?.outcomeJson as Record<string, unknown>)['measurement']).toMatchObject({
      reason: 'page_no_longer_in_store',
    })
  })

  it('is marked as looked-at, so nothing goes back week after week', async () => {
    await connectSearchConsole()
    await seedLivePage()
    const opportunityId = await seedAppliedOptimize()
    await seedCollapse()
    await harness.pool.query(`UPDATE store_pages SET status = 'gone' WHERE account_id = $1`, [
      accountId,
    ])

    await measureOpportunityOutcome(deps(), { accountId, opportunityId })
    const row = await findOpportunityById(db, scope(), opportunityId)
    // The stamp means "we went and looked", not "we have good news". Without it
    // this row is indistinguishable from one whose four weeks are still running.
    expect(row?.outcomeMeasuredAt).toEqual(AT_MATURITY)

    const second = await measureOpportunityOutcome(deps(), { accountId, opportunityId })
    expect(second).toEqual({ status: 'skipped', reason: 'already_measured' })
  })
})

describe.skipIf(!available)('an article the merchant published over our refusal', () => {
  it('is left out, with none of its numbers recorded', async () => {
    await connectSearchConsole()
    await seedLivePage()
    const opportunityId = await seedAppliedOptimize()
    await seedSearchHistory([
      ...windowDays(PAGE, 'before', { clicks: 4, impressions: 100, position: 11.4 }),
      ...windowDays(PAGE, 'after', { clicks: 5, impressions: 125, position: 8.1 }),
    ])
    await attachOverridePublishedArticle()

    const outcome = await measureOpportunityOutcome(deps(), { accountId, opportunityId })
    expect(outcome.status).toBe('unmeasurable')

    const row = await findOpportunityById(db, scope(), opportunityId)
    const stored = row?.outcomeJson as Record<string, unknown>
    expect(stored['measurement']).toMatchObject({
      measured: false,
      reason: 'published_via_override',
    })
    expect(stored).not.toHaveProperty('label')
    // The numbers planted above are a clear improvement, so this is not the
    // arithmetic agreeing by accident: the row would have said "improved". The
    // measurement is refused because of what the article is, and the click
    // counts are not written down anywhere for a later pass to learn from.
    expect(JSON.stringify(stored)).not.toContain('125')
    expect(capture.of('opportunity_outcome_measured')).toHaveLength(0)
  })

  /** The same page, with the override flag cleared, is measured normally. */
  it('is measured normally once the flag is not set', async () => {
    await connectSearchConsole()
    await seedLivePage()
    const opportunityId = await seedAppliedOptimize()
    await seedSearchHistory([
      ...windowDays(PAGE, 'before', { clicks: 4, impressions: 100, position: 11.4 }),
      ...windowDays(PAGE, 'after', { clicks: 5, impressions: 125, position: 8.1 }),
    ])
    await attachOverridePublishedArticle()
    await harness.pool.query(`UPDATE articles SET published_via_override = false`)

    const outcome = await measureOpportunityOutcome(deps(), { accountId, opportunityId })
    expect(outcome.status).toBe('measured')
  })
})

describe.skipIf(!available)('a store whose search data cannot answer', () => {
  it('waits rather than comparing a part-finished four weeks against a whole one', async () => {
    await connectSearchConsole()
    await seedLivePage()
    const opportunityId = await seedAppliedOptimize()
    // A full before window and only half an after window — Search Console is
    // behind. Summed as they stand, this page's clicks halve and the row would
    // read as a decline caused by nothing but the calendar.
    await seedSearchHistory([
      ...windowDays(PAGE, 'before', { clicks: 4, impressions: 100, position: 9 }),
      ...windowDays(PAGE, 'after', { clicks: 4, impressions: 100, position: 9 }).slice(0, 14),
    ])

    const outcome = await measureOpportunityOutcome(deps(), { accountId, opportunityId })
    expect(outcome.status).toBe('awaiting_search_data')

    const row = await findOpportunityById(db, scope(), opportunityId)
    expect(row?.outcomeJson).toBeNull()
    expect(row?.outcomeMeasuredAt).toBeNull()
  })

  it('gives up and says so once waiting has gone on longer than the window itself', async () => {
    await connectSearchConsole()
    await seedLivePage()
    const opportunityId = await seedAppliedOptimize()
    await seedSearchHistory(windowDays(PAGE, 'before', { clicks: 4, impressions: 100, position: 9 }))

    const muchLater = new Date(DUE_AT.getTime() + (OUTCOMES.window_days + 1) * DAY_MS)
    const outcome = await measureOpportunityOutcome(
      { ...deps(), now: () => muchLater },
      { accountId, opportunityId },
    )
    expect(outcome.status).toBe('unmeasurable')
    const row = await findOpportunityById(db, scope(), opportunityId)
    expect((row?.outcomeJson as Record<string, unknown>)['measurement']).toMatchObject({
      reason: 'search_data_incomplete',
    })
  })

  it('answers a store with no Search Console at all once, and does not wait for data that is not coming', async () => {
    await seedLivePage()
    const opportunityId = await seedAppliedOptimize()

    const outcome = await measureOpportunityOutcome(deps(), { accountId, opportunityId })
    expect(outcome.status).toBe('unmeasurable')
    const row = await findOpportunityById(db, scope(), opportunityId)
    expect((row?.outcomeJson as Record<string, unknown>)['measurement']).toMatchObject({
      reason: 'search_console_not_connected',
    })
  })

  it('does not call a page that was invisible before the work a winner', async () => {
    await connectSearchConsole()
    await seedLivePage()
    const opportunityId = await seedAppliedOptimize()
    // Nothing before, real traffic after. A genuine gain, and indistinguishable
    // from a page Google had simply not indexed yet — so no verdict.
    await seedSearchHistory(windowDays(PAGE, 'after', { clicks: 5, impressions: 125, position: 8 }))

    const outcome = await measureOpportunityOutcome(deps(), { accountId, opportunityId })
    expect(outcome.status).toBe('unmeasurable')
    const row = await findOpportunityById(db, scope(), opportunityId)
    expect((row?.outcomeJson as Record<string, unknown>)['measurement']).toMatchObject({
      reason: 'no_baseline',
    })
  })
})

describe.skipIf(!available)('the job the merchant\'s press actually books', () => {
  it('has a handler under the name the booking uses', async () => {
    registerOptimizeTasks({ getPool: () => harness.pool, deps: { db } as never })
    // The failure this card exists to fix: the name was queued and nothing
    // answered to it.
    expect(registeredTaskNames()).toContain(OPPORTUNITY_OUTCOME_MEASURE_TASK)
  })

  it('takes the store\'s lock, which the runtime fails it for skipping', async () => {
    await connectSearchConsole()
    await seedLivePage()
    const opportunityId = await seedAppliedOptimize()
    await seedSearchHistory([
      ...windowDays(PAGE, 'before', { clicks: 4, impressions: 100, position: 11.4 }),
      ...windowDays(PAGE, 'after', { clicks: 5, impressions: 125, position: 8.1 }),
    ])

    registerOptimizeTasks({
      getPool: () => harness.pool,
      capture,
      deps: { db, logger: silentLogger, now: () => AT_MATURITY } as never,
    })

    const handler = taskList()[OPPORTUNITY_OUTCOME_MEASURE_TASK] as (
      payload: unknown,
      helpers: unknown,
    ) => Promise<unknown>

    // The registry wraps a job declared as per-account work in a check that
    // throws unless that account's lock was asked for inside it. Running the
    // real handler through the real registry is what proves the declaration and
    // the lock agree — a handler that quietly stopped locking would fail here.
    await expect(
      handler(
        { accountId, opportunityId, appliedAt: APPLIED_AT.toISOString() },
        { logger: { error: () => {} }, addJob: async () => {} },
      ),
    ).resolves.toBeUndefined()

    const row = await findOpportunityById(db, scope(), opportunityId)
    expect(row?.outcomeMeasuredAt).not.toBeNull()
  })

  it('backs off instead of queueing behind a store that is busy', async () => {
    await connectSearchConsole()
    await seedLivePage()
    const opportunityId = await seedAppliedOptimize()

    registerOptimizeTasks({
      getPool: () => harness.pool,
      capture,
      deps: { db, logger: silentLogger, now: () => AT_MATURITY } as never,
    })
    const handler = taskList()[OPPORTUNITY_OUTCOME_MEASURE_TASK] as (
      payload: unknown,
      helpers: unknown,
    ) => Promise<unknown>

    // Somebody else holds this store — a nightly sync, say. Taken on its own
    // connection with the product's own key, so the job's attempt is refused by
    // Postgres rather than by a stand-in or by the in-process re-entry guard.
    const holder = await harness.pool.connect()
    const { rows } = await holder.query<{ key: string }>(
      'SELECT hashtextextended($1, $2)::text AS key',
      [accountId, ACCOUNT_LOCK_NAMESPACE],
    )
    const key = rows[0]!.key
    await holder.query('SELECT pg_advisory_lock($1)', [key])

    const queued: { runAt?: Date }[] = []
    try {
      await handler(
        { accountId, opportunityId, appliedAt: APPLIED_AT.toISOString() },
        {
          logger: { error: () => {} },
          addJob: async (_name: string, _payload: unknown, options: { runAt?: Date }) => {
            queued.push(options)
          },
        },
      )
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1)', [key])
      holder.release()
    }

    // Nothing was measured and the work was handed back rather than failed.
    expect(queued).toHaveLength(1)
    const row = await findOpportunityById(db, scope(), opportunityId)
    expect(row?.outcomeMeasuredAt).toBeNull()
  })
})

/**
 * Plants one of our own articles behind the store page and marks it
 * override-published — the state a merchant reaches by publishing over the
 * quality gate's refusal.
 */
async function attachOverridePublishedArticle(): Promise<void> {
  const { rows: opportunityRows } = await harness.pool.query<{ id: string }>(
    `INSERT INTO opportunities
       (account_id, signal_type, entity_type, entity_ref, evidence_json, impact, impact_score,
        confidence, reason_template_key, recommended_action, status, rules_version)
     VALUES ($1, 'uncovered_commercial_query', 'query_cluster', 'boots', '{}'::jsonb, 'low', 0, 0,
             'uncovered_commercial_query.create', 'create', 'completed', 'test')
     RETURNING id`,
    [accountId],
  )
  const { rows: topicRows } = await harness.pool.query<{ id: string }>(
    `INSERT INTO topics (account_id, opportunity_id, title, intent_class, source, scheduled_date)
     VALUES ($1, $2, 'Boots', 'informational', 'auto', '2026-07-01') RETURNING id`,
    [accountId, opportunityRows[0]!.id],
  )
  const { rows: articleRows } = await harness.pool.query<{ id: string }>(
    `INSERT INTO articles (account_id, topic_id, title, slug, state, published_via_override)
     VALUES ($1, $2, 'Boots', 'boots', 'published', true) RETURNING id`,
    [accountId, topicRows[0]!.id],
  )
  await harness.pool.query(`UPDATE store_pages SET article_id = $1 WHERE account_id = $2 AND url = $3`, [
    articleRows[0]!.id,
    accountId,
    PAGE,
  ])
}
