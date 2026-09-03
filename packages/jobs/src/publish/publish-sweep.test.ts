import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { makeWorkerUtils, type WorkerUtils } from 'graphile-worker'
import { silentLogger } from '@sortiva/core'
import { schema, type Db } from '@sortiva/db'
import {
  TEST_DATABASE_URL,
  databaseAvailable,
  insertAccount,
  setupTestDb,
  truncateAll,
  type TestDb,
} from '@sortiva/db/testing'
import { sweepPublishDeliveries, type PublishTaskDeps } from './tasks'

/**
 * The hourly sweep that decides *whose* publish hour it is.
 *
 * The publish hour is nine in the morning where the store's audience is — so a
 * German shop and a Californian one are due at two different instants, and no
 * single UTC moment is either of them. This is the sweep that makes one
 * schedule serve both.
 */

const available = await databaseAvailable()

describe.skipIf(!available)('the publish-hour sweep', () => {
  let ctx: TestDb
  let db: Db
  let utils: WorkerUtils

  beforeAll(async () => {
    ctx = await setupTestDb('publish_delivery_sweep')
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

  function deps(now: Date): PublishTaskDeps {
    return {
      getDb: () => db,
      getPool: () => ctx.pool,
      now: () => now,
      logger: silentLogger,
    }
  }

  async function queuedKeys(): Promise<string[]> {
    const { rows } = await ctx.pool.query<{ key: string }>(
      `select j.key from graphile_worker._private_jobs as j
        join graphile_worker._private_tasks as t on t.id = j.task_id
       where t.identifier = 'publish_delivery_account'
       order by j.key`,
    )
    return rows.map((r) => r.key)
  }

  /** Done-when: the publish hour holds across three timezones. */
  it('picks each store at nine in its own morning and nobody else', async () => {
    const utc = await seedStore('utc@example.com', 'UTC')
    const berlin = await seedStore('berlin@example.com', 'Europe/Berlin')
    const la = await seedStore('la@example.com', 'America/Los_Angeles')

    await sweepPublishDeliveries(deps(new Date('2026-09-03T09:00:00.000Z')))
    expect(await queuedKeys()).toEqual([`publish_delivery_account:${utc}:2026-09-03`])

    await ctx.pool.query('TRUNCATE graphile_worker._private_jobs CASCADE')
    await sweepPublishDeliveries(deps(new Date('2026-09-03T07:00:00.000Z')))
    expect(await queuedKeys()).toEqual([`publish_delivery_account:${berlin}:2026-09-03`])

    await ctx.pool.query('TRUNCATE graphile_worker._private_jobs CASCADE')
    await sweepPublishDeliveries(deps(new Date('2026-09-03T16:00:00.000Z')))
    expect(await queuedKeys()).toEqual([`publish_delivery_account:${la}:2026-09-03`])
  })

  it('follows a store that moved its publish hour', async () => {
    const store = await seedStore('evening@example.com', 'UTC', 18)
    await sweepPublishDeliveries(deps(new Date('2026-09-03T09:00:00.000Z')))
    expect(await queuedKeys()).toEqual([])

    await sweepPublishDeliveries(deps(new Date('2026-09-03T18:00:00.000Z')))
    expect(await queuedKeys()).toEqual([`publish_delivery_account:${store}:2026-09-03`])
  })

  it('queues one job however many times the hour is swept', async () => {
    const store = await seedStore('utc@example.com', 'UTC')
    const at = new Date('2026-09-03T09:00:00.000Z')
    await sweepPublishDeliveries(deps(at))
    await sweepPublishDeliveries(deps(at))
    expect(await queuedKeys()).toEqual([`publish_delivery_account:${store}:2026-09-03`])
  })

  it('matches nobody at an hour that is nobody\'s morning', async () => {
    await seedStore('utc@example.com', 'UTC')
    const result = await sweepPublishDeliveries(deps(new Date('2026-09-03T13:00:00.000Z')))
    expect(result).toEqual({ considered: 1, queued: 0 })
    expect(await queuedKeys()).toEqual([])
  })

  it('leaves a deleted account out entirely', async () => {
    const store = await seedStore('gone@example.com', 'UTC')
    await ctx.pool.query('UPDATE accounts SET deleted_at = now() WHERE id = $1', [store])
    const result = await sweepPublishDeliveries(deps(new Date('2026-09-03T09:00:00.000Z')))
    expect(result).toEqual({ considered: 0, queued: 0 })
  })
})
