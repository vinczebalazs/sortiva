import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import {
  findAccountByShopHandle,
  markShopifyConnectionInvalid,
  saveShopifyConnection,
} from './repositories/connections'
import { accountScope, systemScope } from './scope'
import {
  UNIQUE_VIOLATION,
  databaseAvailable,
  insertAccount,
  pgErrorCode,
  setupTestDb,
  truncateAll,
  type TestDb,
} from './testing'

/**
 * Schema wave 4 (card T8.0).
 *
 * One property, tested against a real Postgres because it is the database that
 * has to hold it: a Shopify store can have only one *live* connection, and
 * losing a connection genuinely frees the store rather than locking it away.
 *
 * Before this wave the handle was unique across every row that had ever
 * existed, so an abandoned connection blocked the same store from ever being
 * connected again — by the merchant returning under a new account, or by anyone
 * else. The whole change is the index predicate, and everything below either
 * proves the release works or proves the safety that survived it.
 */

const available = await databaseAvailable()

describe.skipIf(!available)('schema wave 4 — a lost Shopify connection releases the store', () => {
  let ctx: TestDb
  let pool: pg.Pool
  let first: string
  let second: string

  const webhook = systemScope('a Shopify webhook names the store and nothing else')

  const connect = (accountId: string, shopHandle: string) =>
    saveShopifyConnection(ctx.db, accountScope(accountId), {
      shopHandle,
      accessTokenCipher: 'cipher',
      grantedScopes: ['read_products'],
    })

  beforeAll(async () => {
    ctx = await setupTestDb('constraints_wave4')
    pool = ctx.pool
  }, 60_000)

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(pool)
    first = await insertAccount(pool, 'first@example.com')
    second = await insertAccount(pool, 'second@example.com')
  })

  it('still refuses two live connections to one store', async () => {
    await connect(first, 'acme')
    const clash = await connect(second, 'acme').catch((e) => e)
    expect(pgErrorCode(clash)).toBe(UNIQUE_VIOLATION)
  })

  it('lets another account connect a store whose connection was lost', async () => {
    await connect(first, 'acme')
    await markShopifyConnectionInvalid(ctx.db, accountScope(first), new Date())

    // The case that used to be impossible: a merchant who left, and whoever
    // installs the app on that store next. Shopify's own install still gates
    // this, so the store is never handed to someone the merchant did not let in.
    await expect(connect(second, 'acme')).resolves.toBeDefined()

    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM shopify_conns WHERE shop_handle = 'acme'`,
    )
    // Both rows survive: the abandoned one is evidence, not a claim on the store.
    expect(rows[0]!.n).toBe(2)
  })

  it('names the live account when a store carries an abandoned row as well', async () => {
    await connect(first, 'acme')
    await markShopifyConnectionInvalid(ctx.db, accountScope(first), new Date())
    await connect(second, 'acme')

    // Answering with the abandoned account would send an uninstall — or any
    // other store-addressed event — to an account that no longer holds the
    // store, doing nothing to the one that does, and saying nothing about it.
    expect(await findAccountByShopHandle(ctx.db, webhook, 'acme')).toBe(second)
  })

  it('answers "nobody" for a store whose only connection is dead', async () => {
    await connect(first, 'acme')
    await markShopifyConnectionInvalid(ctx.db, accountScope(first), new Date())

    // Right answer, not a missing one: the loss is already recorded, so an
    // uninstall arriving afterwards has nothing left to do.
    expect(await findAccountByShopHandle(ctx.db, webhook, 'acme')).toBeUndefined()
  })

  it('lets the same account reconnect onto its own row, clearing the loss', async () => {
    await connect(first, 'acme')
    await markShopifyConnectionInvalid(ctx.db, accountScope(first), new Date())
    await connect(first, 'acme')

    const { rows } = await pool.query<{ n: number; invalidated_at: Date | null }>(
      `SELECT count(*)::int AS n, min(invalidated_at) AS invalidated_at
       FROM shopify_conns WHERE shop_handle = 'acme'`,
    )
    expect(rows[0]!.n).toBe(1)
    expect(rows[0]!.invalidated_at).toBeNull()
  })

  it('is a partial index, and the predicate is the live-row test', async () => {
    const { rows } = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'shopify_conns_shop_handle_key'`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.indexdef).toMatch(/UNIQUE/)
    expect(rows[0]!.indexdef).toMatch(/WHERE \(invalidated_at IS NULL\)/)
  })
})

describe('database availability (wave 4)', () => {
  it('reports whether the constraint suite actually ran', () => {
    if (!available) {
      throw new Error(
        `No Postgres at the test URL. Constraint tests cannot be skipped silently — run \`pnpm db:up\` first.`,
      )
    }
    expect(available).toBe(true)
  })
})
