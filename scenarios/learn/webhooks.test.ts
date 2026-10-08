import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CONFIG } from '../../core/config.ts'
import { largeCatalog } from '../fixtures/index.ts'
import { startPipeline, type Pipeline } from '../pipeline.ts'

let p: Pipeline
let storeId: number
const domain = 'fernhill-coffee.myshopify.com'

beforeAll(async () => {
  p = await startPipeline()
  storeId = (await p.install('rich-en')).id
  await p.settle()
})
afterAll(() => p?.stop())

const product = (handle: string) => p.shopify.shop(domain).products.find((x) => x.handle === handle)!
const gid = (id: number) => `gid://shopify/Product/${id}`
const llmCalls = async () => (await p.db.pool.query(`select count(*)::int as n from llm_calls`)).rows[0].n as number

describe('product webhooks', () => {
  it('a price change updates the product without a model call', async () => {
    const kettle = product('gooseneck-kettle-900')
    kettle.price = { min: '49.0' }
    const calls = await llmCalls()
    await p.shopify.deliverWebhook(domain, 'products/update', { id: kettle.id, admin_graphql_api_id: gid(kettle.id) })
    await p.settle()
    const { rows } = await p.db.pool.query('select price_min from products where platform_id = $1', [gid(kettle.id)])
    expect(rows[0].price_min).toBe(49)
    expect(await llmCalls()).toBe(calls)
  })

  it('a description change re-extracts that product\'s facts', async () => {
    const press = product('french-press-1l')
    press.descriptionHtml = '<p>Borosilicate glass beaker in a stainless steel frame. 1 litre, about 4 mugs. Four-layer mesh filter. All parts come apart for cleaning; the beaker is replaceable. Lid and plunger are dishwasher safe.</p>'
    const before = await p.db.pool.query(`select f.fact from product_facts f join products p on p.id = f.product_id where p.platform_id = $1`, [gid(press.id)])
    await p.shopify.deliverWebhook(domain, 'products/update', { id: press.id, admin_graphql_api_id: gid(press.id) })
    await p.settle()
    const after = await p.db.pool.query(`select f.fact, f.source_excerpt from product_facts f join products p on p.id = f.product_id where p.platform_id = $1`, [gid(press.id)])
    expect(after.rows.length).toBeGreaterThan(0)
    expect(after.rows.map((r) => r.fact)).not.toEqual(before.rows.map((r) => r.fact))
    expect(after.rows.some((r) => /dishwasher/i.test(r.source_excerpt))).toBe(true)
  })

  it('processes the same delivery once even when Shopify sends it twice', async () => {
    const scale = product('brew-scale-timer')
    const reads = () => p.shopify.requests.filter((r) => r.operation === 'Product' && r.shop === domain).length
    const before = reads()
    const first = await p.shopify.deliverWebhook(domain, 'products/update', { id: scale.id, admin_graphql_api_id: gid(scale.id) }, { webhookId: 'dup-1' })
    const second = await p.shopify.deliverWebhook(domain, 'products/update', { id: scale.id, admin_graphql_api_id: gid(scale.id) }, { webhookId: 'dup-1' })
    expect([first.status, second.status]).toEqual([200, 200])
    await p.settle()
    expect(reads() - before).toBe(1)
    const { rows } = await p.db.pool.query(`select count(*)::int as n from webhook_deliveries where delivery_id = 'dup-1'`)
    expect(rows[0].n).toBe(1)
  })

  it('a deleted product is marked deleted after re-reading it, not on the payload\'s word', async () => {
    const filters = product('paper-filters-02')
    p.shopify.shop(domain).products = p.shopify.shop(domain).products.filter((x) => x !== filters)
    await p.shopify.deliverWebhook(domain, 'products/delete', { id: filters.id })
    await p.settle()
    const { rows } = await p.db.pool.query('select deleted_at from products where platform_id = $1', [gid(filters.id)])
    expect(rows[0].deleted_at).not.toBeNull()
  })

  it('rejects a delivery whose signature does not match', async () => {
    const res = await p.shopify.deliverWebhook(domain, 'products/update', { id: 1 }, { secret: 'not-our-secret' })
    expect(res.status).toBe(401)
  })
})

it('a burst of 500 product updates within a minute becomes a single catalogue re-read', async () => {
  const big = await p.install(largeCatalog(250, 'burst-catalogue.myshopify.com'))
  await p.settle()
  const pagesBefore = p.shopify.requests.filter((r) => r.operation === 'ProductsPage' && r.shop === big.domain).length
  const singleBefore = p.shopify.requests.filter((r) => r.operation === 'Product' && r.shop === big.domain).length
  const products = p.shopify.shop(big.domain).products
  await Promise.all(
    Array.from({ length: 500 }, (_, i) => {
      const prod = products[i % products.length]!
      return p.shopify.deliverWebhook(big.domain, 'products/update', { id: prod.id, admin_graphql_api_id: gid(prod.id) })
    }),
  )
  await p.settle(60_000)
  const pages = p.shopify.requests.filter((r) => r.operation === 'ProductsPage' && r.shop === big.domain).length - pagesBefore
  const singles = p.shopify.requests.filter((r) => r.operation === 'Product' && r.shop === big.domain).length - singleBefore
  expect(pages).toBe(Math.ceil(250 / CONFIG.catalogPageSize))
  expect(singles).toBe(0)
})
