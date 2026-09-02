import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { databaseAvailable, setupTestDb, type TestDb } from './testing'

/**
 * Invariant 4, the other half.
 *
 * Shopify sends every app two privacy messages — "a shopper asked what you hold
 * about them" and "a shopper asked you to erase it" — and our answer to both is
 * that we hold nothing about their shoppers. That answer is meant to be true by
 * construction rather than by policy: order ingestion strips every customer
 * field at read time, so there is nothing to search and nothing to erase.
 *
 * `no-customer-data.test.ts` proves no *column* could hold a shopper's identity.
 * This proves no *table* is about shoppers at all — a `customers` table with
 * columns named `c1`, `c2` would pass the column scan and fail here, and it is
 * the shape somebody reaches for first when they decide they need "just the
 * order emails". Asked of the live database rather than of the schema files,
 * because a migration is what creates a table.
 */

const SHOPPER_WORDS = new Set([
  'customer',
  'customers',
  'shopper',
  'shoppers',
  'buyer',
  'buyers',
  'recipient',
  'recipients',
  'contact',
  'contacts',
  'subscriber',
  'subscribers',
  'address',
  'addresses',
  'orders',
  'order',
])

function namesShoppers(tableName: string): boolean {
  return tableName.split('_').some((word) => SHOPPER_WORDS.has(word))
}

/**
 * Empty on purpose. Every entry would be a table named after the merchant's
 * customers, and there is no such thing here; adding one should require
 * explaining why in this file.
 */
const ALLOWED: Record<string, string> = {}

const available = await databaseAvailable()

describe('invariant 4 — no table holds the merchant’s customers', () => {
  let ctx: TestDb

  beforeAll(async () => {
    ctx = await setupTestDb('no_customer_table')
  }, 60_000)

  afterAll(async () => {
    await ctx?.close()
  })

  it('holds no table named after shoppers, orders or contacts', async () => {
    const { rows } = await ctx.pool.query<{ table_name: string }>(
      `select table_name
         from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'
        order by table_name`,
    )

    // A scan that found nothing would pass by doing nothing.
    expect(rows.length, 'the table scan found no tables at all').toBeGreaterThan(20)

    const offenders = rows
      .map((r) => r.table_name)
      .filter((name) => namesShoppers(name))
      .filter((name) => !(name in ALLOWED))

    expect(
      offenders,
      `These tables are named after the merchant's customers or their orders. We hold neither: ` +
        `order ingestion keeps line-item aggregates only, which is what lets us answer Shopify's ` +
        `customer webhooks "no customer data held" truthfully. Found: ${offenders.join(', ')}`,
    ).toEqual([])
  })

  it('keeps a table that could only be about shoppers out of the aggregates we do keep', async () => {
    // `top_products` and `landing_revenue_daily` are the two order-derived
    // tables. Naming them here means a later card cannot quietly repurpose one.
    const { rows } = await ctx.pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_name in ('top_products', 'landing_revenue_daily')`,
    )
    expect(rows.map((r) => r.table_name).sort()).toEqual(['landing_revenue_daily', 'top_products'])
  })

  it('the rule is not vacuous: a planted table would be caught', () => {
    const planted = ['customers', 'order_contacts', 'shopper_addresses']
    expect(planted.filter((name) => namesShoppers(name) && !(name in ALLOWED))).toEqual(planted)
  })
})

describe('database availability (no-customer-table suite)', () => {
  it('reports whether the table scan actually ran', () => {
    if (!available) {
      throw new Error(
        'No Postgres at the test URL. The no-customer-table scan cannot be skipped silently — ' +
          'run `pnpm db:up` first.',
      )
    }
    expect(available).toBe(true)
  })
})
