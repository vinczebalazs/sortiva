import { afterAll, beforeAll, expect, it } from 'vitest'
import { CONFIG } from '../../core/config.ts'
import { largeCatalog } from '../fixtures/index.ts'
import { startPipeline, type Pipeline } from '../pipeline.ts'

let p: Pipeline
beforeAll(async () => {
  p = await startPipeline()
})
afterAll(() => p?.stop())

it('walks a 250-product catalogue in pages and resumes after a crash at the page it reached', async () => {
  let crashed = false
  p.hooks.checkpoint = (name, n) => {
    if (name === 'catalog_page' && n === 3 && !crashed) {
      crashed = true
      throw new Error('simulated crash after the third page was saved')
    }
  }
  const store = await p.install(largeCatalog(250))
  await p.settle()
  expect(crashed).toBe(true)
  await p.retryFailedNow()
  await p.settle()

  const pageRequests = p.shopify.requests.filter((r) => r.operation === 'ProductsPage' && r.shop === store.domain)
  expect(pageRequests.length).toBe(Math.ceil(250 / CONFIG.catalogPageSize))
  const { rows } = await p.db.pool.query('select count(*)::int as n, count(distinct platform_id)::int as d from products where store_id = $1 and deleted_at is null', [store.id])
  expect(rows[0]).toEqual({ n: 250, d: 250 })
  const leftover = await p.db.pool.query('select count(*)::int as n from job_checkpoints where store_id = $1', [store.id])
  expect(leftover.rows[0].n).toBe(0)
})

it('a product gone from Shopify is marked deleted on the next full walk', async () => {
  const domain = 'large-catalogue.myshopify.com'
  const storeId = await p.storeId(domain)
  const shop = p.shopify.shop(domain)
  const removed = shop.products.pop()!
  await p.syncNow(storeId)
  await p.settle()
  const { rows } = await p.db.pool.query('select deleted_at from products where store_id = $1 and platform_id = $2', [storeId, `gid://shopify/Product/${removed.id}`])
  expect(rows[0].deleted_at).not.toBeNull()
})
