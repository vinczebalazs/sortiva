import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { accountScope, closeDb, dbPool, insertMinimalOpportunity } from '@sortiva/db'
import {
  TEST_DATABASE_URL,
  databaseAvailable,
  insertAccount,
  setupTestDb,
  truncateAll,
  type TestDb,
} from '@sortiva/db/testing'
import { silentLogger } from '@sortiva/core'
import type { GenerateOptimizeDeps } from '@sortiva/jobs/optimize/generate'
import { OPTIMIZE_GENERATE_TASK } from '@sortiva/jobs/optimize/queue'
import { registerOptimizeTasks, resetOptimizeTaskRegistration } from '@sortiva/jobs/optimize/tasks'
import { resetIntentGapTaskRegistration } from '@sortiva/jobs/optimize/intent-gap-tasks'
import { installKillSwitchReader, resetKillSwitchReader } from '@sortiva/jobs/runtime/gate'
import { clearTasks, registerTask, taskList } from '@sortiva/jobs/runtime/tasks'
import {
  TRUNCATE_QUEUE_SQL,
  installQueueSchema,
  type WorkerUtils,
} from '@sortiva/jobs/runtime/testing'
import { startWorker, type StartedWorker } from '@sortiva/jobs/runtime/worker'
import { rules } from '@sortiva/rules'
import { withAccount } from '../../auth/_lib/session'
import { makeGenerateRecommendationHandler, type RecommendationsDeps } from './handlers'

/**
 * The improve-this-page button, from the press to the work actually happening.
 *
 * Everything either side of the join was already built and tested. What was
 * missing is that the press queued work under a name no running code answered
 * to, so the merchant waited for something that would never happen. Three
 * things are proved here, and each is measured rather than asserted about a
 * stand-in:
 *
 *  - the server spends through **one** model client, so wiring a second job to
 *    it did not create a second place a merchant's spending is recorded;
 *  - building what the job runs on talks to no database, because that happens
 *    while the web server is still starting;
 *  - a press reaches a real worker, which is shown by running the same press
 *    twice — once against a worker that has not been told about the job, where
 *    nothing happens, and once against one that has.
 */

/**
 * Every model client this file's module graph builds, in construction order.
 *
 * Counted rather than compared: two bundles handing out the same instance
 * proves they share one, but it cannot prove a third was not built off to the
 * side, and a second client is exactly what two earlier cards refused to add.
 */
const constructed = vi.hoisted(() => [] as unknown[])

vi.mock('@sortiva/llm/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sortiva/llm/client')>()
  class CountedAnthropicLlmClient extends actual.AnthropicLlmClient {
    constructor(options: ConstructorParameters<typeof actual.AnthropicLlmClient>[0]) {
      super(options)
      constructed.push(this)
    }
  }
  return { ...actual, AnthropicLlmClient: CountedAnthropicLlmClient }
})

/** Nothing listens here. A pool that tried to connect would fail loudly rather than quietly succeed. */
const UNREACHABLE_DATABASE = 'postgres://sortiva:sortiva@127.0.0.1:1/sortiva'

const NOW = new Date('2026-09-04T10:00:00.000Z')
const PAGE_URL = 'https://example-store.com/collections/wide-trail-shoes'

describe('what the server starts with', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL

  beforeAll(async () => {
    // The composition root runs before anything has queried, so the address
    // only has to be readable. Pointing it somewhere dead is what turns "the
    // deps builders opened no connection" into something a failure would show.
    await closeDb()
    process.env.DATABASE_URL = UNREACHABLE_DATABASE
    constructed.length = 0
  })

  afterAll(async () => {
    await closeDb()
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = originalDatabaseUrl
    clearTasks()
    resetOptimizeTaskRegistration()
    resetIntentGapTaskRegistration()
  })

  it('builds exactly one model client for every job that spends through one', async () => {
    const { generationTaskDeps, replenishmentTaskDeps } = await import('../../articles/_lib/config')
    const { intentGapTaskDeps, optimizeTaskDeps } = await import('./config')

    const generation = generationTaskDeps()
    const optimize = optimizeTaskDeps()
    const intentGap = intentGapTaskDeps()
    // Replenishment is here to prove it stays as it is: it plans from rows we
    // already hold, and giving it a model client would make a planning pass
    // able to start spending.
    const replenishment = replenishmentTaskDeps()

    expect(constructed).toHaveLength(1)
    expect(new Set([generation.llm, optimize.deps.llm, intentGap.llm]).size).toBe(1)
    expect(generation.llm).toBe(constructed[0])
    expect(replenishment).not.toHaveProperty('llm')

    // Asked for a second time — which is what a restarted registration would
    // do — and still the same one.
    expect(optimizeTaskDeps().deps.llm).toBe(constructed[0])
    expect(constructed).toHaveLength(1)
  })

  it('registers both jobs without opening a database connection', async () => {
    const { registerIntentGapTasks } = await import('@sortiva/jobs/optimize/intent-gap-tasks')
    const { intentGapTaskDeps, optimizeTaskDeps } = await import('./config')

    clearTasks()
    resetOptimizeTaskRegistration()
    resetIntentGapTaskRegistration()

    // Exactly what the composition root does, against a database that is not
    // there. Anything that ran a query here would throw.
    registerOptimizeTasks(optimizeTaskDeps())
    registerIntentGapTasks(intentGapTaskDeps())

    expect(Object.keys(taskList())).toContain(OPTIMIZE_GENERATE_TASK)

    // The pool exists — building the deps names it — and has never been used.
    // `totalCount` counts connections the pool has actually made.
    const pool = dbPool()
    expect(pool.totalCount, 'a connection was opened while registering').toBe(0)
    expect(pool.idleCount).toBe(0)
    expect(pool.waitingCount).toBe(0)
  })
})

const available = await databaseAvailable()

describe.skipIf(!available)('pressing the button reaches a worker', () => {
  let harness: TestDb
  let queueUtils: WorkerUtils
  let connectionString: string
  let accountId: string

  /**
   * What the generation runs on. The three paid seams throw: the case below
   * drives a page the store's inventory has no record of, which the real
   * generation refuses before it buys anything, so a call to any of them would
   * mean the refusal had stopped working.
   */
  function generationDeps(): GenerateOptimizeDeps {
    const refuse = (what: string) => () => {
      throw new Error(`nothing may ${what} for a page that is not in the inventory`)
    }
    return {
      db: harness.db,
      seo: { serpTop: refuse('buy a results page') } as unknown as GenerateOptimizeDeps['seo'],
      pageFetcher: { fetch: refuse('read a page') } as unknown as GenerateOptimizeDeps['pageFetcher'],
      llm: { complete: refuse('ask a model') } as unknown as GenerateOptimizeDeps['llm'],
      coveragePrompt: { version: 'intent-gap.v1', text: 'unused' },
      recommendationPrompt: { version: 'optimize-reco.v1', text: 'unused' },
      judge: () => ({ grade: refuse('grade anything') }),
      logger: silentLogger,
      now: () => NOW,
    }
  }

  function pressDeps(): RecommendationsDeps {
    return {
      db: harness.db,
      labels: {} as RecommendationsDeps['labels'],
      now: () => NOW,
    }
  }

  const press = (opportunityId: string) =>
    withAccount(makeGenerateRecommendationHandler(pressDeps()), async () => accountId)(
      new Request('http://localhost/api/recommendations', {
        method: 'POST',
        body: JSON.stringify({ opportunityId }),
      }),
      undefined,
    )

  async function statusOf(opportunityId: string): Promise<string | undefined> {
    const { rows } = await harness.pool.query<{ status: string }>(
      'SELECT status FROM opportunities WHERE id = $1',
      [opportunityId],
    )
    return rows[0]?.status
  }

  async function queuedGenerations(): Promise<number> {
    const { rows } = await harness.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM graphile_worker._private_jobs j
         JOIN graphile_worker._private_tasks t ON t.id = j.task_id
        WHERE t.identifier = $1`,
      [OPTIMIZE_GENERATE_TASK],
    )
    return rows[0]?.n ?? 0
  }

  /** Runs a worker over whatever is registered, until the deadline or the condition holds. */
  async function runWorkerUntil(done: () => Promise<boolean>, ms: number): Promise<boolean> {
    let worker: StartedWorker | undefined
    try {
      worker = await startWorker({ connectionString, taskList: taskList(), concurrency: 1, enableCron: false })
      const deadline = Date.now() + ms
      while (Date.now() < deadline) {
        if (await done()) return true
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      return false
    } finally {
      await worker?.stop().catch(() => {})
    }
  }

  beforeAll(async () => {
    harness = await setupTestDb('optimize_wire')
    const url = new URL(TEST_DATABASE_URL)
    url.pathname = `/${harness.databaseName}`
    connectionString = url.toString()
    queueUtils = await installQueueSchema(connectionString)
  }, 60_000)

  afterAll(async () => {
    await queueUtils?.release()
    await harness?.close()
  })

  beforeEach(async () => {
    await truncateAll(harness.pool)
    await harness.pool.query(TRUNCATE_QUEUE_SQL)
    clearTasks()
    resetOptimizeTaskRegistration()
    installKillSwitchReader(() => harness.db)
    accountId = await insertAccount(harness.pool, `optimize-wire-${Date.now()}@example.com`)
    await harness.pool.query(
      'INSERT INTO subscriptions (account_id, stripe_subscription_id, price_id, status) VALUES ($1, $2, $3, $4)',
      [accountId, 'sub_wire', 'price_wire', 'active'],
    )
  })

  afterEach(() => {
    clearTasks()
    resetOptimizeTaskRegistration()
    resetKillSwitchReader()
  })

  async function optimizeOpportunity(): Promise<string> {
    const row = await insertMinimalOpportunity(
      harness.db,
      accountScope(accountId),
      {
        signalType: 'existing_page_intent_gap',
        entityType: 'url',
        entityRef: PAGE_URL,
        evidenceJson: [{ key: 'query_cluster', value: 'wide trail running shoes', source: 'gsc' }],
        recommendedAction: 'optimize',
        status: 'new',
        reasonTemplateKey: 'opportunity.existing_page_intent_gap',
        reasonParams: {},
        limitedIntelligence: false,
        rulesVersion: rules().rulesVersion,
      },
      NOW,
    )
    return row.id
  }

  it('leaves the press unanswered while nothing is registered for it, and answers it once something is', async () => {
    const opportunityId = await optimizeOpportunity()

    const response = await press(opportunityId)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ state: 'generating', generated: true })
    expect(await queuedGenerations()).toBe(1)
    expect(await statusOf(opportunityId)).toBe('executing')

    // A worker that was never told about this job. Something else is registered
    // so the worker has a task list at all — the point is that this job is not
    // in it, which is the state the product shipped in.
    registerTask('optimize_wire_probe', async () => {})
    const pickedUpUnregistered = await runWorkerUntil(async () => (await queuedGenerations()) === 0, 3_000)

    expect(pickedUpUnregistered, 'the job ran with nothing registered for it').toBe(false)
    expect(await queuedGenerations()).toBe(1)
    expect(await statusOf(opportunityId), 'the page is still marked as being worked on').toBe('executing')

    // The registration the composition root makes.
    registerOptimizeTasks({ getPool: () => harness.pool, deps: generationDeps() })
    const pickedUp = await runWorkerUntil(async () => (await queuedGenerations()) === 0, 20_000)

    expect(pickedUp, 'the registered job was never picked up').toBe(true)
    // The real generation ran, found no such page in the store's inventory, and
    // handed the page back — which is what the merchant sees as the drawer
    // resolving instead of spinning for ever.
    expect(await statusOf(opportunityId)).toBe('accepted')
  }, 60_000)
})

describe('database availability', () => {
  it('reports whether the end-to-end case actually ran', () => {
    if (!available) {
      throw new Error('No Postgres at the test URL. Run `pnpm db:up` first.')
    }
    expect(available).toBe(true)
  })
})
