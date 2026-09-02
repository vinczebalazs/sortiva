import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { accountScope, systemScope } from './scope'
import {
  accountsWithLiveShopifyConnection,
  familyIdsByShopifyProductId,
  listStorePages,
  readStorePageBody,
  storePageChecksums,
  upsertStorePages,
  type StorePageInput,
} from './repositories/inventory'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from './testing'

/**
 * The inventory against a real Postgres, because the two things that matter
 * about it are database behaviour: that re-reading a store converges on the same
 * rows rather than accumulating them, and that a nightly read cannot demote a
 * page we published back to an ordinary blog post.
 */

const available = await databaseAvailable()

function page(over: Partial<StorePageInput> = {}): StorePageInput {
  return {
    url: 'https://shop.example/collections/boots',
    pageType: 'collection',
    handle: 'boots',
    shopifyId: '1',
    title: 'Boots',
    seoTitle: 'Boots',
    seoDescription: 'Every boot we sell.',
    headings: ['Waterproof'],
    bodyHtml: '<p>Boots for the hills.</p>',
    outboundInternalLinks: ['https://shop.example/pages/sizing'],
    familyIds: [],
    checksum: 'checksum-1',
    ...over,
  }
}

describe.skipIf(!available)('the store content inventory', () => {
  let ctx: TestDb
  let pool: pg.Pool
  let accountId: string

  beforeAll(async () => {
    ctx = await setupTestDb('inventory')
    pool = ctx.pool
  })

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(pool)
    accountId = await insertAccount(pool, 'inventory@example.com')
  })

  it('holds one row per address however often the store is read', async () => {
    const scope = accountScope(accountId)
    await upsertStorePages(ctx.db, scope, [page()])
    await upsertStorePages(ctx.db, scope, [page({ title: 'Walking boots', checksum: 'checksum-2' })])

    const rows = await listStorePages(ctx.db, scope)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.title).toBe('Walking boots')
    expect(rows[0]?.checksum).toBe('checksum-2')
  })

  it('reads the body back as it was published', async () => {
    const scope = accountScope(accountId)
    await upsertStorePages(ctx.db, scope, [page({ bodyHtml: '<p>Boots for the hills.</p>' })])
    const [row] = await listStorePages(ctx.db, scope)
    expect(readStorePageBody(row!)).toBe('<p>Boots for the hills.</p>')
  })

  it('reports the checksums it holds, and nothing for addresses it has never seen', async () => {
    const scope = accountScope(accountId)
    await upsertStorePages(ctx.db, scope, [page()])
    const known = await storePageChecksums(ctx.db, scope, [
      'https://shop.example/collections/boots',
      'https://shop.example/pages/about',
    ])
    expect(known.get('https://shop.example/collections/boots')).toBe('checksum-1')
    expect(known.has('https://shop.example/pages/about')).toBe(false)
  })

  it('never demotes an article of ours back to an ordinary blog post', async () => {
    const scope = accountScope(accountId)
    const url = 'https://shop.example/blogs/journal/winter-boots'
    await upsertStorePages(ctx.db, scope, [
      page({ url, pageType: 'article_ours', handle: 'winter-boots', shopifyId: '77' }),
    ])
    await upsertStorePages(ctx.db, scope, [
      page({ url, pageType: 'blog_article', handle: 'winter-boots', shopifyId: '77', title: 'Edited' }),
    ])

    const rows = await listStorePages(ctx.db, scope)
    expect(rows[0]?.pageType).toBe('article_ours')
    expect(rows[0]?.title).toBe('Edited')
  })

  it('sees only its own account, even when another store has the same address', async () => {
    const other = await insertAccount(pool, 'other@example.com')
    await upsertStorePages(ctx.db, accountScope(accountId), [page()])
    await upsertStorePages(ctx.db, accountScope(other), [page({ title: 'Someone else' })])

    const rows = await listStorePages(ctx.db, accountScope(accountId))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.title).toBe('Boots')
  })

  it('finds a product family by the id the store gave the product', async () => {
    const scope = accountScope(accountId)
    const family = await pool.query(
      `insert into product_families (account_id, name, grouping_source, confidence)
       values ($1, 'Hiking boots', 'collection', 'high') returning id`,
      [accountId],
    )
    const familyId = family.rows[0].id as string
    await pool.query(
      `insert into products (account_id, shopify_product_id, title, family_id)
       values ($1, 'p1', 'Trailblazer', $2), ($1, 'p2', 'Townsman', null)`,
      [accountId, familyId],
    )

    const map = await familyIdsByShopifyProductId(ctx.db, scope, ['p1', 'p2', 'p3'])
    expect(map.get('p1')).toBe(familyId)
    expect(map.has('p2')).toBe(false)
    expect(map.has('p3')).toBe(false)
  })

  it('lists the stores whose connection is still good', async () => {
    const dead = await insertAccount(pool, 'dead@example.com')
    await pool.query(
      `insert into shopify_conns (account_id, shop_handle, access_token) values ($1, 'live-shop', 'x')`,
      [accountId],
    )
    await pool.query(
      `insert into shopify_conns (account_id, shop_handle, access_token, invalidated_at)
       values ($1, 'dead-shop', 'x', now())`,
      [dead],
    )

    const live = await accountsWithLiveShopifyConnection(
      ctx.db,
      systemScope('the nightly inventory sweep chooses which stores to work for'),
    )
    expect(live).toEqual([accountId])
  })
})
