import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { makeWorkerUtils, type WorkerUtils } from 'graphile-worker'
import { silentLogger, StubNotificationEmitter } from '@sortiva/core'
import { schema, type Db } from '@sortiva/db'
import {
  TEST_DATABASE_URL,
  databaseAvailable,
  insertAccount,
  setupTestDb,
  truncateAll,
  type TestDb,
} from '@sortiva/db/testing'
import { loadPrompt } from '@sortiva/llm'
import { sweepGenerationCycles, type GenerationTaskDeps } from './tasks'

/**
 * The hourly sweep that decides *whose* day it is.
 *
 * The point of these cases is that "the daily cycle" is not one moment: a
 * German store and a Californian store both have to start a fixed number of
 * hours before their own publish hour, and one UTC time cannot be both. So the
 * sweep runs every hour and matches only the stores whose local clock has just
 * reached that point.
 */

const available = await databaseAvailable()

describe.skipIf(!available)('the generation-cycle sweep', () => {
  let ctx: TestDb
  let db: Db
  let utils: WorkerUtils

  beforeAll(async () => {
    ctx = await setupTestDb('generation_cycle_sweep')
    db = ctx.db as unknown as Db
    // The queue's own tables are installed by the worker, not by our migrations.
    const url = new URL(TEST_DATABASE_URL)
    url.pathname = `/${ctx.databaseName}`
    utils = await makeWorkerUtils({ connectionString: url.toString() })
  })

  afterAll(async () => {
    await utils?.release()
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(ctx.pool)
    await ctx.pool.query('TRUNCATE graphile_worker._private_jobs CASCADE')
  })

  async function seedStore(email: string, timezone: string, publishHour = 9): Promise<string> {
    const accountId = await insertAccount(ctx.pool, email)
    await db.insert(schema.accountSettings).values({ accountId, timezone, publishHour })
    return accountId
  }

  function deps(now: Date): GenerationTaskDeps {
    return {
      getDb: () => db,
      getPool: () => ctx.pool,
      llm: { complete: () => Promise.reject(new Error('the sweep never calls a model')) },
      pageFetcher: { fetch: () => Promise.reject(new Error('the sweep never fetches')) },
      seo: {
        keywordMetrics: () => Promise.reject(new Error('not called')),
        serpTop: () => Promise.reject(new Error('not called')),
        rankedKeywords: () => Promise.reject(new Error('not called')),
      },
      claimPlanPrompt: loadPrompt('claim-plan', 1),
      draftPrompt: loadPrompt('draft', 1),
      judgePrompt: loadPrompt('judge', 1),
      contradictionPrompt: loadPrompt('contradiction', 1),
      revisePrompt: loadPrompt('revise', 1),
      // The sweep only queues jobs; nothing it does reaches the bell.
      notifications: new StubNotificationEmitter(),
      now: () => now,
      logger: silentLogger,
    }
  }

  async function queuedKeys(): Promise<string[]> {
    const { rows } = await ctx.pool.query<{ key: string }>(
      `select j.key from graphile_worker._private_jobs as j
        join graphile_worker._private_tasks as t on t.id = j.task_id
       where t.identifier = 'generation_cycle_account'
       order by j.key`,
    )
    return rows.map((r) => r.key)
  }

  /**
   * Six hours before a 09:00 publish hour is 03:00 local. At 03:00 UTC that is
   * the UTC store's moment and nobody else's; at 01:00 UTC it is Berlin's
   * (03:00 there); at 10:00 UTC it is Los Angeles's (03:00 there).
   */
  it('picks each store at its own local hour and nobody else', async () => {
    const utc = await seedStore('utc@example.com', 'UTC')
    const berlin = await seedStore('berlin@example.com', 'Europe/Berlin')
    const la = await seedStore('la@example.com', 'America/Los_Angeles')

    await sweepGenerationCycles(deps(new Date('2026-09-03T03:00:00.000Z')))
    expect(await queuedKeys()).toEqual([`generation_cycle_account:${utc}:2026-09-03`])

    await ctx.pool.query('TRUNCATE graphile_worker._private_jobs CASCADE')
    await sweepGenerationCycles(deps(new Date('2026-09-03T01:00:00.000Z')))
    expect(await queuedKeys()).toEqual([`generation_cycle_account:${berlin}:2026-09-03`])

    await ctx.pool.query('TRUNCATE graphile_worker._private_jobs CASCADE')
    await sweepGenerationCycles(deps(new Date('2026-09-03T10:00:00.000Z')))
    expect(await queuedKeys()).toEqual([`generation_cycle_account:${la}:2026-09-03`])
  })

  it('matches nobody at an hour that is nobody\'s morning', async () => {
    await seedStore('utc@example.com', 'UTC')
    const result = await sweepGenerationCycles(deps(new Date('2026-09-03T15:00:00.000Z')))
    expect(result).toEqual({ considered: 1, queued: 0 })
    expect(await queuedKeys()).toEqual([])
  })

  it('follows a store that moved its publish hour', async () => {
    const store = await seedStore('late@example.com', 'UTC', 18)
    await sweepGenerationCycles(deps(new Date('2026-09-03T03:00:00.000Z')))
    expect(await queuedKeys()).toEqual([])

    await sweepGenerationCycles(deps(new Date('2026-09-03T12:00:00.000Z')))
    expect(await queuedKeys()).toEqual([`generation_cycle_account:${store}:2026-09-03`])
  })

  it('queues one job for a store even if the same hour is swept twice', async () => {
    const store = await seedStore('utc@example.com', 'UTC')
    const at = new Date('2026-09-03T03:00:00.000Z')
    await sweepGenerationCycles(deps(at))
    await sweepGenerationCycles(deps(at))
    expect(await queuedKeys()).toEqual([`generation_cycle_account:${store}:2026-09-03`])
  })

  it('leaves a deleted account out entirely', async () => {
    const store = await seedStore('gone@example.com', 'UTC')
    await ctx.pool.query('UPDATE accounts SET deleted_at = now() WHERE id = $1', [store])
    const result = await sweepGenerationCycles(deps(new Date('2026-09-03T03:00:00.000Z')))
    expect(result).toEqual({ considered: 0, queued: 0 })
  })
})
