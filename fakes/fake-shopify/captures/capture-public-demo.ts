import { writeFileSync } from 'node:fs'
import { SCHEMA_ENDPOINT } from '../schema/fetch.ts'
import { PINNED_VERSION } from '../schema/pinned.ts'
import * as q from '../../../connectors/shopify/queries.ts'

/**
 * Shopify's documentation explorer answers read queries with real data from its own demo shop.
 * These captures are real Shopify responses to our exact documents, but they are not recordings
 * from our dev store: no token, no scopes, no mutations, and the explorer's proxy sits in between.
 */
const endpoint = SCHEMA_ENDPOINT(PINNED_VERSION)
const out = new URL('./public-demo-shop/', import.meta.url)

async function capture(name: string, query: string, variables: Record<string, unknown> = {}) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })
  const body = (await response.json()) as any
  const record = {
    source: 'shopify.dev admin-graphql-direct-proxy (Shopify public demo shop)',
    endpoint,
    apiVersion: PINNED_VERSION,
    capturedAt: new Date().toISOString(),
    request: { document: name, variables },
    status: response.status,
    body,
  }
  writeFileSync(new URL(`${name}.json`, out), JSON.stringify(record, null, 2) + '\n')
  return body
}

await capture('SHOP', q.SHOP)
await capture('APP_SCOPES', q.APP_SCOPES)
const products = await capture('PRODUCTS_PAGE', q.PRODUCTS_PAGE, { first: 3 })
const cursor = products.data.products.pageInfo.endCursor
await capture('PRODUCTS_PAGE.second', q.PRODUCTS_PAGE, { first: 3, after: cursor })
await capture('PRODUCT', q.PRODUCT, { id: products.data.products.nodes[0].id })
await capture('PRODUCT.missing', q.PRODUCT, { id: 'gid://shopify/Product/1' })
await capture('PRODUCTS_COUNT', q.PRODUCTS_COUNT)
await capture('COLLECTIONS_PAGE', q.COLLECTIONS_PAGE, { first: 3 })
await capture('PAGES_PAGE', q.PAGES_PAGE, { first: 3 })
await capture('BLOGS', q.BLOGS, { first: 3 })
const articles = await capture('ARTICLES_PAGE', q.ARTICLES_PAGE, { first: 3 })
await capture('RECENT_ARTICLES_WITH_MARKER', q.RECENT_ARTICLES_WITH_MARKER, { first: 3 })
const articleId = articles.data?.articles?.nodes?.[0]?.id
if (articleId) await capture('ARTICLE', q.ARTICLE, { id: articleId })
await capture('ARTICLE.missing', q.ARTICLE, { id: 'gid://shopify/Article/1' })

// The explorer does not enforce the cost ceiling or the throttle, so refusals cannot be captured here.
console.log('captured into fakes/fake-shopify/captures/public-demo-shop/')
