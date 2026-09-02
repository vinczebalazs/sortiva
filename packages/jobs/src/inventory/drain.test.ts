import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { makeWorkerUtils, type WorkerUtils } from 'graphile-worker'
import { StubCatalogEvents, silentLogger, type CatalogEvent } from '@sortiva/core'
import {
  TEST_DATABASE_URL,
  databaseAvailable,
  insertAccount,
  setupTestDb,
  truncateAll,
  type TestDb,
} from '@sortiva/db/testing'
import { drainCatalogEvents } from './drain'
import { INVENTORY_SYNC_TASK } from './queue'

/**
 * The reading half of the catalogue change stream.
 *
 * The half that produces the changes is Lane B's `T2.2` and is not built, so
 * this runs against the frozen contract's own stand-in — which is the point of
 * freezing it. What is being proved is that a burst of changes becomes the
 * smallest set of re-reads it can, queued once.
 */

const available = await databaseAvailable()

const ACCOUNT_EVENTS: readonly CatalogEvent[] = [
  {
    accountId: 'ignored',
    kind: 'collection_updated',
    entityId: '12',
    occurredAt: '2026-03-01T09:00:00.000Z',
    changedFields: ['body_html'],
  },
  {
    accountId: 'ignored',
    kind: 'price_changed',
    entityId: '31',
    occurredAt: '2026-03-01T09:01:00.000Z',
    changedFields: ['price'],
  },
  {
    accountId: 'ignored',
    kind: 'product_updated',
    entityId: '31',
    occurredAt: '2026-03-01T09:02:00.000Z',
    changedFields: ['body_html'],
  },
  {
    accountId: 'ignored',
    kind: 'product_updated',
    entityId: '31',
    occurredAt: '2026-03-01T09:03:00.000Z',
    changedFields: ['title'],
  },
]

describe.skipIf(!available)('catalogue changes reaching the inventory', () => {
  let ctx: TestDb
  let pool: pg.Pool
  let utils: WorkerUtils
  let accountId: string

  beforeAll(async () => {
    ctx = await setupTestDb('inventory-drain')
    pool = ctx.pool
    // The queue's own tables are installed by the worker, not by our migrations,
    // and this suite asserts on what actually reached the queue.
    const url = new URL(TEST_DATABASE_URL)
    url.pathname = `/${ctx.databaseName}`
    utils = await makeWorkerUtils({ connectionString: url.toString() })
  })

  afterAll(async () => {
    await utils?.release()
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(pool)
    await pool.query('TRUNCATE graphile_worker._private_jobs CASCADE')
    accountId = await insertAccount(pool, 'drain@example.com')
  })

  async function queuedSyncs(): Promise<{ payload: InventoryJobPayload; key: string | null }[]> {
    const { rows } = await pool.query<{ payload: InventoryJobPayload; key: string | null }>(
      `select j.payload, j.key
         from graphile_worker._private_jobs as j
         join graphile_worker._private_tasks as t on t.id = j.task_id
        where t.identifier = $1
        order by j.id`,
      [INVENTORY_SYNC_TASK],
    )
    return rows
  }

  it('asks for one re-read per changed page, and none for a price change', async () => {
    const result = await drainCatalogEvents(
      { getDb: () => ctx.db, catalogEvents: new StubCatalogEvents(ACCOUNT_EVENTS), logger: silentLogger },
      { accountId },
    )

    expect(result.events).toBe(4)
    expect(result.requested).toBe(2)

    const queued = await queuedSyncs()
    expect(queued).toHaveLength(1)
    expect([...(queued[0]?.payload.targets ?? [])].sort(byId)).toEqual([
      { kind: 'collection', shopifyId: '12' },
      { kind: 'product', shopifyId: '31' },
    ])
  })

  it('hands back a place to resume, and a second pass over the same stream asks for nothing', async () => {
    const events = new StubCatalogEvents(ACCOUNT_EVENTS)
    const deps = { getDb: () => ctx.db, catalogEvents: events, logger: silentLogger }

    const first = await drainCatalogEvents(deps, { accountId })
    expect(first.cursor).toBe('2026-03-01T09:03:00.000Z')

    const second = await drainCatalogEvents(deps, { accountId, cursor: first.cursor })

    expect(second.events).toBe(0)
    expect(second.requested).toBe(0)
    expect(await queuedSyncs()).toHaveLength(1)
  })

  it('counts a deletion without asking for the deleted page to be read', async () => {
    const deleted: CatalogEvent = {
      accountId: 'ignored',
      kind: 'product_deleted',
      entityId: '33',
      occurredAt: '2026-03-01T10:00:00.000Z',
      changedFields: [],
    }

    const result = await drainCatalogEvents(
      { getDb: () => ctx.db, catalogEvents: new StubCatalogEvents([deleted]), logger: silentLogger },
      { accountId },
    )

    expect(result.removed).toBe(1)
    expect(result.requested).toBe(0)
    expect(await queuedSyncs()).toEqual([])
  })
})

interface InventoryJobPayload {
  readonly accountId: string
  readonly targets?: readonly { kind: string; shopifyId: string }[]
}

function byId(a: { shopifyId: string }, b: { shopifyId: string }): number {
  return a.shopifyId.localeCompare(b.shopifyId)
}
