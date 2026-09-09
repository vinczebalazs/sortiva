import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  accountScope,
  insertArticleStub,
  insertMinimalOpportunity,
  insertTopic,
  type Db,
} from '@sortiva/db'
import {
  TEST_DATABASE_URL,
  databaseAvailable,
  insertAccount,
  setupTestDb,
  truncateAll,
  type TestDb,
} from '@sortiva/db/testing'
import { makeWorkerUtils, type WorkerUtils } from 'graphile-worker'
import { sql } from 'drizzle-orm'
import { assertCrontabTasksExist, CRON_ENTRIES } from '../runtime/crontab'
import { resetKillSwitchReader } from '../runtime/gate'
import { clearTasks, registeredTaskNames, taskList } from '../runtime/tasks'
import {
  LEARNING_RECOMPUTE_ACCOUNT_TASK,
  LEARNING_RECOMPUTE_SWEEP_TASK,
  registerLearningTasks,
  resetLearningTaskRegistration,
} from './tasks'

/**
 * The weekly learning run, wired.
 *
 * Two things are worth proving here rather than in the pure rule's own tests.
 * The schedule names this job, and a scheduled name with no handler stops the
 * worker starting — so the entry and the registration have to land together.
 * And the job declares that it works on one store's data, which the runtime
 * enforces by **failing** the job if it finishes without having asked for that
 * store's lock: these cases run the handler the deployed worker would run, so
 * the declaration is checked rather than trusted.
 */

const available = await databaseAvailable()
const NOW = new Date('2026-09-07T00:00:00.000Z')
/** How far behind today the store's search history stops, as Google's does. */
const SEARCH_DATA_LAG_DAYS = 3
const NEWEST_SEARCH_DAY = '2026-09-04'

const run = async (name: string, payload: unknown): Promise<unknown> => {
  const handler = taskList()[name] as (payload: unknown, helpers: unknown) => Promise<unknown>
  if (!handler) throw new Error(`no handler registered for ${name}`)
  return handler(payload, { logger: { error: () => {} } })
}

describe('the schedule and the handlers land together', () => {
  afterEach(() => {
    clearTasks()
    resetLearningTaskRegistration()
    resetKillSwitchReader()
  })

  it('schedules the weekly run', () => {
    expect(CRON_ENTRIES.map((entry) => entry.task)).toContain(LEARNING_RECOMPUTE_SWEEP_TASK)
  })

  it('leaves no scheduled name of its own without a handler', () => {
    // Inverting the burden rather than naming the one entry: every crontab line
    // this module is responsible for has to be satisfied by registering it, so
    // a second scheduled name added later without a handler fails here too.
    const ours = CRON_ENTRIES.filter((entry) => entry.task.startsWith('learning_'))
    expect(ours.length).toBeGreaterThan(0)
    expect(() => assertCrontabTasksExist(registeredTaskNames(), ours)).toThrow()

    registerLearningTasks({ getDb: () => null as never, getPool: () => null as never })
    expect(() => assertCrontabTasksExist(registeredTaskNames(), ours)).not.toThrow()
  })

  it('registers both halves of the run', () => {
    registerLearningTasks({ getDb: () => null as never, getPool: () => null as never })
    expect(registeredTaskNames()).toContain(LEARNING_RECOMPUTE_SWEEP_TASK)
    expect(registeredTaskNames()).toContain(LEARNING_RECOMPUTE_ACCOUNT_TASK)
  })

  it('is declared as working on one store, which the runtime says in its own words', async () => {
    // This message comes from the runtime's per-account check, not from the
    // handler: `account_from_record`, `fans_out` and `none` each produce
    // something else or nothing. So it is the declaration itself under test
    // here, and the real-data case below is what proves the lock is then taken.
    registerLearningTasks({ getDb: () => null as never, getPool: () => null as never })
    await expect(run(LEARNING_RECOMPUTE_ACCOUNT_TASK, {})).rejects.toThrow(
      /registered as per-account work but its payload names no account/,
    )
  })
})

describe.skipIf(!available)('the weekly learning run against real data', () => {
  let ctx: TestDb
  let db: Db
  let utils: WorkerUtils
  let accountId: string
  const captured: { event: string; properties?: Record<string, unknown> }[] = []

  beforeAll(async () => {
    ctx = await setupTestDb('learning_tasks')
    db = ctx.db as unknown as Db
    // The queue's own tables are installed by the worker, not by our migrations.
    const url = new URL(TEST_DATABASE_URL)
    url.pathname = `/${ctx.databaseName}`
    utils = await makeWorkerUtils({ connectionString: url.toString() })
  }, 60_000)

  afterAll(async () => {
    await utils?.release()
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(ctx.pool)
    await ctx.pool.query('TRUNCATE graphile_worker._private_jobs CASCADE')
    clearTasks()
    resetLearningTaskRegistration()
    resetKillSwitchReader()
    captured.length = 0
    nextDay = 0
    accountId = await insertAccount(ctx.pool, 'learning-job@example.com')
    registerLearningTasks({
      getDb: () => db,
      getPool: () => ctx.pool,
      capture: {
        capture: (event: { event: string; properties?: Record<string, unknown> }) => {
          captured.push({
            event: event.event,
            ...(event.properties ? { properties: event.properties } : {}),
          })
        },
      },
      now: () => NOW,
    })
  })

  afterEach(() => {
    clearTasks()
    resetLearningTaskRegistration()
  })

  let nextDay = 0

  /** A published article with a run of Search Console days behind it. */
  async function publishedArticle(
    clicksPerDay: number,
    over: { readonly intentClass?: 'buying_guide' | 'how_to'; readonly override?: boolean } = {},
  ): Promise<string> {
    const scope = accountScope(accountId)
    const opportunity = await insertMinimalOpportunity(
      db,
      scope,
      {
        signalType: 'uncovered_commercial_query',
        entityType: 'query_cluster',
        entityRef: `q-${Math.random()}`,
        evidenceJson: [],
        recommendedAction: 'create',
        status: 'accepted',
        reasonTemplateKey: 'uncovered_commercial_query.create',
        reasonParams: {},
        limitedIntelligence: false,
        rulesVersion: 'test',
      },
      NOW,
    )
    const topic = await insertTopic(
      db,
      scope,
      {
        opportunityId: opportunity.id,
        title: 'Best trail shoes for wide feet',
        targetKeyword: 'trail shoes wide feet',
        keywordCluster: null,
        intentClass: over.intentClass ?? 'buying_guide',
        familyIds: [],
        kind: 'new',
        source: 'auto',
        whyLine: 'x',
        scheduledDate: `2026-01-${String((nextDay++ % 28) + 1).padStart(2, '0')}`,
        pinned: false,
        state: 'published',
      },
      NOW,
    )
    const stub = await insertArticleStub(
      db,
      scope,
      {
        topicId: topic.id,
        title: 'Best trail shoes for wide feet',
        slug: `trail-shoes-${Math.random()}`,
        targetKeyword: 'trail shoes wide feet',
        state: 'draft',
      },
      NOW,
    )
    const url = `https://shop.example/blogs/news/${stub.id}`
    await db.execute(sql`
      update articles
      set state = 'published',
          published_via_override = ${over.override ?? false},
          delivery = 'auto',
          published_url = ${url},
          published_at = '2026-01-01T00:00:00.000Z'
      where id = ${stub.id}
    `)

    // Nine weeks of daily rows, so both the trailing window and the one behind
    // it are full — but stopping three days short of today, because Google
    // reports that far behind and the windows have to be anchored on the newest
    // day the store actually has rather than on the day the job runs.
    for (let back = SEARCH_DATA_LAG_DAYS; back < SEARCH_DATA_LAG_DAYS + 60; back++) {
      const day = new Date(NOW.getTime() - back * 86_400_000).toISOString().slice(0, 10)
      await ctx.pool.query(
        `INSERT INTO gsc_daily (account_id, date, page, clicks, impressions, position)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [accountId, day, url, clicksPerDay, 30, 8],
      )
    }
    return stub.id
  }

  async function storedLabels(): Promise<{ label: string }[]> {
    const { rows } = await ctx.pool.query(
      `SELECT l.label FROM article_labels l JOIN articles a ON a.id = l.article_id
       WHERE a.account_id = $1`,
      [accountId],
    )
    return rows
  }

  async function storedPatterns(): Promise<{ dimension: string; dimension_value: string }[]> {
    const { rows } = await ctx.pool.query(
      `SELECT dimension::text, dimension_value FROM pattern_stats WHERE account_id = $1`,
      [accountId],
    )
    return rows
  }

  it('runs both passes and is not failed for skipping the store’s lock', async () => {
    // The runtime throws when a job declared as working on one store finishes
    // without having asked for that store's lock. So this passing is the
    // assertion: the declaration is honest and the lock is taken. If either
    // changed, the handler would reject rather than return.
    for (let i = 0; i < 5; i++) await publishedArticle(1, { intentClass: 'how_to' })
    for (let i = 0; i < 3; i++) await publishedArticle(20, { intentClass: 'buying_guide' })

    await run(LEARNING_RECOMPUTE_ACCOUNT_TASK, { accountId })

    expect(await storedLabels()).toHaveLength(8)
    expect(
      (await storedPatterns()).some((row) => row.dimension_value === 'buying_guide'),
    ).toBe(true)
  })

  it('reports each verdict without saying which article it was about', async () => {
    for (let i = 0; i < 5; i++) await publishedArticle(1, { intentClass: 'how_to' })
    for (let i = 0; i < 3; i++) await publishedArticle(20, { intentClass: 'buying_guide' })

    await run(LEARNING_RECOMPUTE_ACCOUNT_TASK, { accountId })

    const labelled = captured.filter((event) => event.event === 'article_labeled')
    expect(labelled).toHaveLength(8)
    for (const event of labelled) {
      expect(Object.keys(event.properties ?? {}).sort()).toEqual(['age_days', 'label'])
    }
  })

  it('says nothing about an article it was not willing to judge', async () => {
    await publishedArticle(20, { override: true })
    await run(LEARNING_RECOMPUTE_ACCOUNT_TASK, { accountId })

    // A row is still written — the refusal is recorded, not skipped — but no
    // event is reported for it and no pattern moves.
    expect(await storedLabels()).toEqual([{ label: 'unrated' }])
    expect(captured.filter((event) => event.event === 'article_labeled')).toEqual([])
    expect(await storedPatterns()).toEqual([])
  })

  it('judges the four weeks ending on the newest search day, not the four ending today', async () => {
    // Google reports two to three days late. Anchored on today, the trailing
    // window would be missing its last few days while the window behind it was
    // full, and those missing days would read as a collapse in every article at
    // once.
    await publishedArticle(1)
    await run(LEARNING_RECOMPUTE_ACCOUNT_TASK, { accountId })

    const { rows } = await ctx.pool.query<{ window_end: string }>(
      `SELECT to_char(l.window_end, 'YYYY-MM-DD') AS window_end FROM article_labels l
       JOIN articles a ON a.id = l.article_id WHERE a.account_id = $1`,
      [accountId],
    )
    expect(rows.map((row) => row.window_end)).toEqual([NEWEST_SEARCH_DAY])
  })

  it('corrects the same week rather than judging it twice', async () => {
    for (let i = 0; i < 5; i++) await publishedArticle(1, { intentClass: 'how_to' })
    await run(LEARNING_RECOMPUTE_ACCOUNT_TASK, { accountId })
    const first = await storedLabels()

    await run(LEARNING_RECOMPUTE_ACCOUNT_TASK, { accountId })
    expect(await storedLabels()).toEqual(first)
  })

  it('judges nothing for a store with no search history at all', async () => {
    // Limited Intelligence: the loop is specified to run without Search
    // Console, learning nothing rather than failing.
    await ctx.pool.query('DELETE FROM gsc_daily WHERE account_id = $1', [accountId])
    await expect(run(LEARNING_RECOMPUTE_ACCOUNT_TASK, { accountId })).resolves.toBeUndefined()
    expect(await storedLabels()).toEqual([])
  })

  it('queues one job per planning store and none for a store still being set up', async () => {
    await ctx.pool.query(
      `INSERT INTO domains (account_id, domain_normalized, state)
       VALUES ($1, $2, 'ready_for_planning')`,
      [accountId, 'shop.example'],
    )
    const onboarding = await insertAccount(ctx.pool, 'onboarding@example.com')
    await ctx.pool.query(
      `INSERT INTO domains (account_id, domain_normalized, state)
       VALUES ($1, $2, 'needs_confirmation')`,
      [onboarding, 'other.example'],
    )

    await run(LEARNING_RECOMPUTE_SWEEP_TASK, {})

    const { rows } = await ctx.pool.query<{ key: string }>(
      `select j.key from graphile_worker._private_jobs as j
        join graphile_worker._private_tasks as t on t.id = j.task_id
       where t.identifier = $1`,
      [LEARNING_RECOMPUTE_ACCOUNT_TASK],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.key).toContain(accountId)
  })
})
