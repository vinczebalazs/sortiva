import { writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { encrypt } from '../../config/crypto.ts'
import { env, optionalEnv } from '../../config/env.ts'
import { createPool, type Db } from '../../db/pool.ts'
import { describeConnectorBehaviour, type Backend } from './behaviour.ts'
import { ShopifyClient } from './client.ts'
import { ShopifyConnector } from './connector.ts'
import { BLOG_DELETE, CONTRACT_BLOGS } from './contract-queries.ts'
import { StoredTokens, type ShopifyAppConfig } from './tokens.ts'

/**
 * Runs the connector behaviours against the sacrificial dev store. Needs the app installed there
 * once (the store row and its token live in DATABASE_URL). With RECORD=1 every real answer is
 * written to fakes/fake-shopify/recordings/, named after the response template it stands for.
 */
const domain = optionalEnv('SHOPIFY_DEV_STORE_DOMAIN')
const recordingsDir = new URL('../../fakes/fake-shopify/recordings/', import.meta.url)

const TEMPLATE_BY_OPERATION: Record<string, string> = {
  Shop: 'query.shop',
  AppScopes: 'query.currentAppInstallation',
  ProductsPage: 'query.products',
  Product: 'query.product',
  ProductsCount: 'query.productsCount',
  CollectionsPage: 'query.collections',
  PagesPage: 'query.pages',
  Blogs: 'query.blogs',
  ArticlesPage: 'query.articles',
  RecentArticles: 'query.articles',
  Article: 'query.article',
  BlogCreate: 'mutation.blogCreate',
  ArticleCreate: 'mutation.articleCreate',
  ArticleUpdate: 'mutation.articleUpdate',
}

function startRecording(): () => void {
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const response = await original(input, init)
    const url = String(input)
    const body = typeof init?.body === 'string' ? init.body : init?.body?.toString()
    const copy = response.clone()
    const text = await copy.text()
    let template: string | undefined
    let request: unknown = body
    if (url.endsWith('/graphql.json') && body) {
      const parsed = JSON.parse(body) as { query: string; variables: unknown }
      const operation = /(?:query|mutation)\s+(\w+)/.exec(parsed.query)?.[1] ?? ''
      template = TEMPLATE_BY_OPERATION[operation]
      if (text.includes('"THROTTLED"')) template = 'error.THROTTLED'
      if (text.includes('"ACCESS_DENIED"')) template = 'error.ACCESS_DENIED'
      if (template === 'mutation.articleUpdate' && text.includes('"NOT_FOUND"')) template = 'mutation.articleUpdate.notFound'
      if (response.status === 401) template = 'http.401'
      request = { document: operation, variables: parsed.variables }
    } else if (url.endsWith('/admin/oauth/access_token')) {
      const grant = new URLSearchParams(body ?? '').get('grant_type')
      template = grant === 'refresh_token' ? (response.ok ? 'oauth.refresh' : 'oauth.refresh.invalid') : 'oauth.tokenExchange'
      request = { grant_type: grant }
    }
    if (template) {
      const redacted = text.replace(/"(access_token|refresh_token)":"[^"]+"/g, '"$1":"<redacted>"')
      writeFileSync(
        new URL(`${template}.json`, recordingsDir),
        JSON.stringify({
          source: `dev store ${domain}`,
          apiVersion: response.headers.get('x-shopify-api-version'),
          capturedAt: new Date().toISOString(),
          request,
          status: response.status,
          body: JSON.parse(redacted || 'null'),
        }, null, 2) + '\n',
      )
    }
    return response
  }
  return () => {
    globalThis.fetch = original
  }
}

describe.skipIf(!domain)('contract: the real dev store', () => {
  let db: Db
  let backend: Backend
  let stopRecording = () => {}

  beforeAll(async () => {
    db = createPool()
    const app: ShopifyAppConfig = {
      clientId: env('SHOPIFY_CLIENT_ID'),
      clientSecret: env('SHOPIFY_CLIENT_SECRET'),
      apiVersion: env('SHOPIFY_API_VERSION'),
      baseUrlFor: (shop) => `https://${shop}`,
    }
    const { rows } = await db.query<{ id: number }>('select id from stores where shop_domain = $1 and closed_at is null', [domain])
    if (!rows[0]) throw new Error(`install the app on ${domain} first; see docs/for-the-founders.md`)
    if (process.env.RECORD === '1') stopRecording = startRecording()
    const client = new ShopifyClient(app, domain!, new StoredTokens(db, app, rows[0].id))
    const connector = new ShopifyConnector(client)
    backend = {
      connector,
      pinnedVersion: app.apiVersion,
      lastApiVersion: () => client.lastApiVersion,
      cleanUp: async () => {
        const { blogs } = await client.request<{ blogs: { nodes: { id: string; title: string }[] } }>(CONTRACT_BLOGS)
        for (const blog of blogs.nodes.filter((b) => b.title.startsWith('Contract contract-'))) {
          await client.request(BLOG_DELETE, { id: blog.id })
        }
      },
      deadTokenConnector: async () => {
        const dead = await db.query<{ id: number }>(
          `insert into stores (shop_domain, access_token_enc, access_token_expires_at, refresh_token_enc, closed_at)
           values ($1, $2, now() - interval '1 hour', $3, now()) returning id`,
          [`contract-dead-${Date.now()}.invalid`, encrypt('shpat_dead'), encrypt('shprt_dead')],
        )
        return new ShopifyConnector(new ShopifyClient({ ...app, baseUrlFor: () => `https://${domain}` }, domain!, new StoredTokens(db, app, dead.rows[0]!.id)))
      },
    }
  })
  afterAll(async () => {
    stopRecording()
    await db?.query(`delete from stores where shop_domain like 'contract-dead-%'`)
    await db?.end()
  })

  it('has a dev store to talk to', () => {})
  describeConnectorBehaviour(`dev store ${domain}`, () => backend)
})
