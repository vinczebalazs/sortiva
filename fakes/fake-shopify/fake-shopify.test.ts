import { readdirSync, readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as q from '../../connectors/shopify/queries.ts'
import { shapeDifferences } from '../shared/shape.ts'
import { PINNED_VERSION } from './schema/pinned.ts'
import { startFakeShopify, type FakeShopify } from './server.ts'
import { PINNED_VERSION_RETIRES_AT, TEMPLATES } from './templates.ts'
import type { FixtureStore } from './state.ts'

const fixture: FixtureStore = {
  shop: {
    name: 'Shape Check',
    myshopifyDomain: 'shape-check.myshopify.com',
    primaryDomainHost: 'shape-check.example',
    defaultLocale: 'en',
    country: 'GB',
    ianaTimezone: 'Europe/London',
    currencyCode: 'GBP',
  },
  collections: [{ handle: 'mugs', title: 'Mugs' }],
  products: [
    {
      handle: 'stoneware-mug',
      title: 'Stoneware mug',
      productType: 'Mug',
      vendor: 'Shape Check',
      tags: ['stoneware'],
      descriptionHtml: '<p>Holds 350 ml.</p>',
      price: { min: '12.0' },
      images: [{ url: 'https://cdn.shopify.com/s/files/mug.jpg', width: 1200, height: 1200, altText: null }],
      collections: ['mugs'],
      metafields: [{ namespace: 'custom', key: 'capacity_ml', type: 'number_integer', value: '350' }],
    },
  ],
  pages: [{ handle: 'about', title: 'About', body: '<p>About us</p>' }],
  blogs: [{ handle: 'news', title: 'News', articles: [{ handle: 'hello', title: 'Hello', body: '<p>Hi</p>' }] }],
}

const clientId = 'test-client'
const clientSecret = 'test-secret'
let fake: FakeShopify
let token: string
const domain = fixture.shop.myshopifyDomain

async function gql(query: string, variables: Record<string, unknown> = {}, accessToken = token) {
  const res = await fetch(`${fake.baseUrlFor(domain)}/admin/api/${PINNED_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-shopify-access-token': accessToken },
    body: JSON.stringify({ query, variables }),
  })
  return { status: res.status, headers: res.headers, body: (await res.json()) as any }
}

async function exchange(sessionToken: string) {
  const res = await fetch(`${fake.baseUrlFor(domain)}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: sessionToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
      requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
      expiring: '1',
    }),
  })
  return { status: res.status, body: (await res.json()) as any }
}

beforeAll(async () => {
  fake = await startFakeShopify({ clientId, clientSecret })
  fake.addShop(fixture)
  token = (await exchange(fake.mintSessionToken(domain))).body.access_token
})
afterAll(() => fake?.close())

describe("the fake's answers have the same form as Shopify's demo shop answers to our exact documents", () => {
  const dir = new URL('./captures/public-demo-shop/', import.meta.url)
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    it(file.replace('.json', ''), async () => {
      const capture = JSON.parse(readFileSync(new URL(file, dir), 'utf8'))
      const name = capture.request.document.split('.')[0] as keyof typeof q
      const variables = { ...capture.request.variables }
      if (name === 'PRODUCT' && !file.includes('missing')) variables.id = (await gql(q.PRODUCTS_PAGE, { first: 1 })).body.data.products.nodes[0].id
      if (variables.after) delete variables.after
      const ours = await gql(q[name] as string, variables)
      expect(ours.status).toBe(capture.status)
      expect(shapeDifferences(ours.body, capture.body)).toEqual([])
    })
  }
})

const recordingsDir = new URL('./recordings/', import.meta.url)
const recordings = readdirSync(recordingsDir).filter((f) => f.endsWith('.json'))

// Fires the day the first recording from a dev store lands: from then on every template needs one.
describe.skipIf(recordings.length === 0)('every response template descends from a recording of the real Shopify', () => {
  for (const template of TEMPLATES) {
    it(`${template.name} has a recording`, () => {
      expect(recordings).toContain(template.recording)
    })
  }
})

describe('the fake behaves as Shopify documents', () => {
  it('answers with the pinned version header, even when asked for another version', async () => {
    const res = await fetch(`${fake.baseUrlFor(domain)}/admin/api/2023-01/graphql.json`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-shopify-access-token': token },
      body: JSON.stringify({ query: q.SHOP }),
    })
    expect(res.headers.get('x-shopify-api-version')).toBe(PINNED_VERSION)
  })

  it('issues expiring tokens with a refresh token, and retires the old refresh token on use', async () => {
    const first = await exchange(fake.mintSessionToken(domain))
    expect(first.body).toMatchObject({ expires_in: 3600, refresh_token_expires_in: 7_776_000 })
    expect(first.body.access_token).toMatch(/^shpat_/)
    const refresh = async (refreshToken: string) => {
      const res = await fetch(`${fake.baseUrlFor(domain)}/admin/oauth/access_token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken }),
      })
      return { status: res.status, body: (await res.json()) as any }
    }
    const second = await refresh(first.body.refresh_token)
    expect(second.status).toBe(200)
    expect(await refresh(first.body.refresh_token)).toEqual({ status: 401, body: { error: 'invalid_request' } })
  })

  it('refuses an expired or forged session token', async () => {
    expect((await exchange(fake.mintSessionToken(domain, { expiresInSeconds: -10 }))).status).toBe(400)
    expect((await exchange(fake.mintSessionToken(domain, { secret: 'someone-else' }))).status).toBe(400)
  })

  it('rejects an expired access token with 401', async () => {
    const own = (await exchange(fake.mintSessionToken(domain))).body.access_token
    fake.expireAccessTokens(domain)
    expect((await gql(q.SHOP, {}, own)).status).toBe(401)
    token = (await exchange(fake.mintSessionToken(domain))).body.access_token
  })

  it('refuses a field whose scope was not granted, naming the scope', async () => {
    fake.revokeScope(domain, 'read_content')
    const res = await gql(q.BLOGS, { first: 5 })
    expect(res.body.errors[0].extensions.code).toBe('ACCESS_DENIED')
    fake.shop(domain).grantedScopes.push('read_content')
  })

  it('refuses a query over the single-query ceiling with the documented error', async () => {
    const res = await gql('{ products(first: 250) { nodes { collections(first: 250) { nodes { id } } } } }')
    expect(res.body.errors[0].extensions).toMatchObject({ code: 'MAX_COST_EXCEEDED', maxCost: 1000 })
  })

  it('throttles once the bucket is drained, and reports the bucket on every answer', async () => {
    const heavy = '{ products(first: 100) { nodes { collections(first: 3) { nodes { id } } } } }'
    const codes: string[] = []
    for (let i = 0; i < 6; i++) {
      const res = await gql(heavy)
      codes.push(res.body.errors?.[0]?.extensions?.code ?? 'ok')
      expect(res.body.extensions.cost.throttleStatus.maximumAvailable).toBe(2000)
    }
    expect(codes).toContain('THROTTLED')
    fake.shop(domain).bucket.available = 2000
  })

  it('creates an article with a marker, finds it by listing, and refuses to update an id that does not exist', async () => {
    const blogId = (await gql(q.BLOGS, { first: 5 })).body.data.blogs.nodes[0].id
    const created = await gql(q.ARTICLE_CREATE, {
      article: { blogId, title: 'Marked', body: '<p>x</p>', author: { name: 'Sortiva' }, metafields: [{ namespace: q.MARKER_NAMESPACE, key: q.MARKER_KEY, type: 'single_line_text_field', value: 'A-1' }] },
    })
    expect(created.body.data.articleCreate.userErrors).toEqual([])
    const recent = await gql(q.RECENT_ARTICLES_WITH_MARKER, { first: 5 })
    expect(recent.body.data.articles.nodes[0].marker).toEqual({ value: 'A-1' })
    const missing = await gql(q.ARTICLE_UPDATE, { id: 'gid://shopify/Article/1', article: { title: 'x' } })
    expect(missing.body.data.articleUpdate).toMatchObject({ article: null, userErrors: [{ code: 'NOT_FOUND' }] })
  })
})

describe('the pinned API version', () => {
  it('is not within three months of retirement', () => {
    const threeMonths = 92 * 24 * 3600 * 1000
    expect(PINNED_VERSION_RETIRES_AT.getTime() - Date.now(), `API ${PINNED_VERSION} retires on ${PINNED_VERSION_RETIRES_AT.toISOString()}; pin a newer version`).toBeGreaterThan(threeMonths)
  })
})
