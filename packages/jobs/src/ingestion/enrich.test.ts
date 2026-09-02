import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ENRICHMENT_PAUSED_FLAG } from '@sortiva/core'
import {
  accountScope,
  addManualKeyword,
  listKeywords,
  systemScope,
  tripGlobalFlag,
  upsertPersona,
} from '@sortiva/db'
import {
  TEST_DATABASE_URL,
  databaseAvailable,
  insertAccount,
  setupTestDb,
  truncateAll,
  type TestDb,
} from '@sortiva/db/testing'
import { MockSeoDataProvider } from '@sortiva/providers'
import { TRUNCATE_QUEUE_SQL, installQueueSchema, type WorkerUtils } from '../runtime/testing'
import { enrichKeyword, enqueueKeywordEnrichment, KEYWORD_ENRICH_TASK } from './enrich'

/**
 * Pricing a term the merchant typed, on the lane that runs ahead of everything
 * else.
 *
 * The cases worth having are the ones about *not* buying: a term somebody else
 * already priced, a term the merchant removed again between the click and the
 * job, and a day whose search-data bill has crossed its ceiling. Each is an
 * ordinary consequence of an at-least-once queue, and each would otherwise be a
 * vendor call nobody asked for.
 */

let harness: TestDb
let queue: WorkerUtils
let accountId: string

async function seedPersona(): Promise<void> {
  await upsertPersona(harness.db, accountScope(accountId), {
    description: 'Acme sells trail running shoes.',
    productCategories: ['trail shoes'],
    language: 'en',
    country: 'GB',
    audience: 'Trail runners',
    tone: 'plain',
    richnessScore: 6,
    promptVersion: 'persona.v1',
    modelId: 'claude-sonnet-test',
  })
}

function seo(): MockSeoDataProvider {
  return new MockSeoDataProvider({
    keywordMetrics: {
      'barefoot trail shoes': { monthlySearchVolume: 320, competition: 0.25, cpcUsd: 0.9 },
    },
  })
}

describe.skipIf(!(await databaseAvailable()))('pricing a hand-typed search term', () => {
  beforeAll(async () => {
    harness = await setupTestDb('keyword_enrich')
    const url = new URL(TEST_DATABASE_URL)
    url.pathname = `/${harness.databaseName}`
    queue = await installQueueSchema(url.toString())
  }, 60_000)

  afterAll(async () => {
    await queue?.release()
    await harness?.close()
  })

  beforeEach(async () => {
    await truncateAll(harness.pool)
    await harness.pool.query(TRUNCATE_QUEUE_SQL)
    accountId = await insertAccount(harness.pool, 'enrich@example.com')
    await seedPersona()
  })

  it('prices the term in the store’s own market and stamps when it did', async () => {
    const scope = accountScope(accountId)
    await addManualKeyword(harness.db, scope, {
      term: 'barefoot trail shoes',
      language: 'en',
      country: 'GB',
    })

    const provider = seo()
    const result = await enrichKeyword(
      { db: harness.db, pool: harness.pool, seo: provider },
      { accountId, term: 'barefoot trail shoes' },
    )

    expect(result.priced).toBe(true)
    const [row] = await listKeywords(harness.db, scope)
    expect(row?.volume).toBe(320)
    expect(row?.difficulty).toBe(25)
    expect(row?.enrichedAt).not.toBeNull()
    // Still the merchant's term, not one of ours.
    expect(row?.source).toBe('manual')
    expect(provider.billableCalls).toBe(1)
  })

  it('buys nothing for a term that is already priced', async () => {
    const scope = accountScope(accountId)
    await addManualKeyword(harness.db, scope, {
      term: 'barefoot trail shoes',
      language: 'en',
      country: 'GB',
    })

    const provider = seo()
    const deps = { db: harness.db, pool: harness.pool, seo: provider }
    await enrichKeyword(deps, { accountId, term: 'barefoot trail shoes' })

    // The queue is at-least-once, so this is an ordinary redelivery.
    const again = await enrichKeyword(deps, { accountId, term: 'barefoot trail shoes' })
    expect(again).toEqual({ priced: false, reason: 'already_fresh' })
    expect(provider.billableCalls).toBe(1)
  })

  it('buys nothing for a term the merchant removed between the click and the job', async () => {
    const provider = seo()
    const result = await enrichKeyword(
      { db: harness.db, pool: harness.pool, seo: provider },
      { accountId, term: 'a term that was removed' },
    )
    expect(result).toEqual({ priced: false, reason: 'already_fresh' })
    expect(provider.calls).toHaveLength(0)
  })

  it('buys nothing while the day’s search-data bill is over its ceiling', async () => {
    await addManualKeyword(harness.db, accountScope(accountId), {
      term: 'barefoot trail shoes',
      language: 'en',
      country: 'GB',
    })
    await tripGlobalFlag(harness.db, systemScope('test raises the spend switch'), {
      flag: ENRICHMENT_PAUSED_FLAG,
      actor: 'test',
      reason: 'the day’s search-data spend crossed its cap',
      trippedBy: 'auto',
    })

    const provider = seo()
    const result = await enrichKeyword(
      { db: harness.db, pool: harness.pool, seo: provider },
      { accountId, term: 'barefoot trail shoes' },
    )
    expect(result).toEqual({ priced: false, reason: 'paused' })
    expect(provider.calls).toHaveLength(0)
  })

  it('is queued ahead of everything else, once per term however often it is asked for', async () => {
    await enqueueKeywordEnrichment(harness.db, { accountId, term: 'barefoot trail shoes' })
    await enqueueKeywordEnrichment(harness.db, { accountId, term: 'barefoot trail shoes' })

    const { rows } = await harness.pool.query<{ n: string; priority: number }>(
      `select count(*)::text as n, min(priority) as priority
         from graphile_worker.jobs
        where task_identifier = $1`,
      [KEYWORD_ENRICH_TASK],
    )
    expect(rows[0]?.n).toBe('1')
    // Everything else in the product queues at the default of zero, and lower
    // runs first.
    expect(rows[0]?.priority).toBeLessThan(0)
  })
})
