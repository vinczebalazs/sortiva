import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { SHOPIFY_READ_SCOPES, signPublishGrantState, staticShopifyAuth } from '@sortiva/core'
import { accountScope, readAccountSettings, readPublishTarget, schema } from '@sortiva/db'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { FakeShopifyPublishClient, MockShopifyOAuthClient } from '@sortiva/providers'
import { withAccount } from '../../auth/_lib/session'
import {
  makeListBlogsHandler,
  makePublishGrantCallbackHandler,
  makeSetDeliveryModeHandler,
  makeSetTargetBlogHandler,
  makeStartPublishGrantHandler,
  type PublishGrantDeps,
} from './handlers'

/**
 * The three steps of turning auto-publish on, over HTTP.
 *
 * The one that matters most is a refusal: **auto-publish cannot be switched on
 * without a blog to post to.** A store left in that state would fail silently
 * every morning at its publish hour with nothing the merchant could do, so the
 * route refuses with a code the Settings screen treats as the next step rather
 * than as an error.
 */

const available = await databaseAvailable()
const NOW = new Date('2026-09-03T08:00:00.000Z')
/** The app secret: it signs our own state value and Shopify signs callbacks with it. */
const GRANT_SECRET = 'test-secret'

describe.skipIf(!available)('turning auto-publish on', () => {
  let harness: TestDb
  let accountId: string
  let shop: FakeShopifyPublishClient
  let oauth: MockShopifyOAuthClient

  beforeAll(async () => {
    harness = await setupTestDb('web_publish_routes')
  })

  afterAll(async () => {
    await harness.close()
  })

  beforeEach(async () => {
    await truncateAll(harness.pool)
    accountId = await insertAccount(harness.pool, 'publish-routes@example.com')
    shop = new FakeShopifyPublishClient()
    oauth = new MockShopifyOAuthClient(GRANT_SECRET)
  })

  async function connect(scopes: readonly string[]): Promise<void> {
    await harness.db.insert(schema.shopifyConns).values({
      accountId,
      shopHandle: 'acme',
      accessToken: 'enc:token',
      grantedScopes: [...scopes],
    })
  }

  function deps(): PublishGrantDeps {
    return {
      db: harness.db,
      shopify: shop,
      oauth,
      cipher: {
        encrypt: (value) => `enc:${value}`,
        decrypt: (value) => value.replace(/^enc:/, ''),
      },
      // How a route reaches the store. Tokens die after an hour and renew
      // themselves, so a caller asks for one rather than holding it; these
      // routes make one call each and never outlive a token.
      authFor: async () => staticShopifyAuth('acme', 'token'),
      stateSecret: GRANT_SECRET,
      redirectUri: 'https://app.example/api/publish/grant/callback',
      settingsUrl: 'https://app.example/settings/publishing',
      now: () => NOW,
    }
  }

  const call = (
    handler: ReturnType<typeof withAccount>,
    init?: RequestInit,
  ): Promise<Response> =>
    handler(new Request('https://app.example/api/publish/x', init), undefined)

  const route = (make: (d: PublishGrantDeps) => Parameters<typeof withAccount>[0]) =>
    withAccount(make(deps()), async () => accountId)

  const json = async (response: Response) => (await response.json()) as Record<string, unknown>

  describe('the second consent', () => {
    it('sends the merchant to a consent screen that asks for posting permission', async () => {
      await connect(SHOPIFY_READ_SCOPES)
      const response = await call(route(makeStartPublishGrantHandler), { method: 'POST' })
      expect(response.status).toBe(200)
      const url = new URL(((await json(response)) as { url: string }).url)
      expect(url.searchParams.get('scope')).toContain('write_content')
      // And the read permissions survive it: Shopify replaces a token's whole
      // scope set per grant, so dropping them would trade the catalogue sync
      // for the ability to publish.
      for (const scope of SHOPIFY_READ_SCOPES) {
        expect(url.searchParams.get('scope')).toContain(scope)
      }
    })

    it('refuses for a store that has not connected at all', async () => {
      const response = await call(route(makeStartPublishGrantHandler), { method: 'POST' })
      expect(response.status).toBe(409)
    })
  })

  describe('coming back from the posting consent screen', () => {
    /** A genuine return trip: signed by Shopify, carrying our own state value. */
    function grantCallback(): Request {
      const state = signPublishGrantState(
        { accountId, shop: 'acme', issuedAt: NOW.getTime() },
        GRANT_SECRET,
      )
      const query = oauth.signCallback({
        shop: 'acme.myshopify.com',
        code: 'one-time',
        state,
        timestamp: '1756000000',
      })
      const url = new URL('https://app.example/api/publish/grant/callback')
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
      return new Request(url, { method: 'GET' })
    }

    async function connRow() {
      const [row] = await harness.db
        .select()
        .from(schema.shopifyConns)
        .where(eq(schema.shopifyConns.accountId, accountId))
      return row!
    }

    /**
     * Recorded permanently, and this is the only place it is written: it is what
     * lets the merchant reconnect their store later without the publishing
     * permission Shopify hands back being thrown away as unasked-for.
     */
    it('writes down that this merchant allowed posting, and keeps the renewal token', async () => {
      await connect(SHOPIFY_READ_SCOPES)
      oauth.grants({
        grantedScopes: [...SHOPIFY_READ_SCOPES, 'write_content'],
        expiresAt: new Date(NOW.getTime() + 3_600_000),
        refreshToken: 'shprt_renewal',
        refreshTokenExpiresAt: new Date(NOW.getTime() + 7_776_000_000),
      })

      const handler = withAccount(makePublishGrantCallbackHandler(deps()), async () => accountId)
      const response = await handler(grantCallback(), undefined)

      expect(response.headers.get('location')).toContain('publish_grant=granted')
      const row = await connRow()
      expect(row.grantedScopes).toContain('write_content')
      expect(row.publishGrantedAt).toEqual(NOW)
      // Stored encrypted, and stored at all: a token that cannot be renewed
      // stops working an hour into the merchant's first day of publishing.
      expect(row.refreshToken).toBe('enc:shprt_renewal')
      expect(row.accessTokenExpiresAt).not.toBeNull()
    })

    /**
     * Shopify would not trade the code — it was already spent, or it expired
     * while the merchant left the tab open. A page saying so is something they
     * can act on; before, this threw and they were shown a crash.
     */
    it('sends the merchant back with a reason when Shopify will not trade the code', async () => {
      await connect(SHOPIFY_READ_SCOPES)
      oauth.failsWith(new Error('shopify is down'))

      const handler = withAccount(makePublishGrantCallbackHandler(deps()), async () => accountId)
      const response = await handler(grantCallback(), undefined)

      expect(response.headers.get('location')).toContain('shopify_exchange_failed')
      expect((await connRow()).publishGrantedAt).toBeNull()
    })
  })

  describe('choosing a blog', () => {
    it('will not list blogs for a store that has not granted posting permission', async () => {
      await connect(SHOPIFY_READ_SCOPES)
      const response = await call(route(makeListBlogsHandler))
      expect(response.status).toBe(409)
      expect((await json(response)).error).toMatchObject({ code: 'write_scope_required' })
      // Nothing was asked of the shop at all.
      expect(shop.calls).toEqual([])
    })

    it('lists them once permission exists', async () => {
      await connect([...SHOPIFY_READ_SCOPES, 'write_content'])
      const response = await call(route(makeListBlogsHandler))
      expect(response.status).toBe(200)
      expect((await json(response)).blogs).toEqual([
        { id: 'blog-1', title: 'News', handle: 'news' },
      ])
    })

    it('creates one in a click for a store that has no blog', async () => {
      await connect([...SHOPIFY_READ_SCOPES, 'write_content'])
      const response = await call(route(makeSetTargetBlogHandler), {
        method: 'POST',
        body: JSON.stringify({ createNamed: 'Guides' }),
      })
      expect(response.status).toBe(200)
      const target = await readPublishTarget(harness.db, accountScope(accountId))
      expect(target?.targetBlogHandle).toBe('guides')
      expect(shop.blogs.map((b) => b.title)).toContain('Guides')
    })

    it('refuses a blog the store no longer has, rather than recording it', async () => {
      await connect([...SHOPIFY_READ_SCOPES, 'write_content'])
      const response = await call(route(makeSetTargetBlogHandler), {
        method: 'POST',
        body: JSON.stringify({ blogId: 'blog-that-was-deleted' }),
      })
      expect(response.status).toBe(409)
      expect((await json(response)).error).toMatchObject({ code: 'blog_not_found' })
      expect((await readPublishTarget(harness.db, accountScope(accountId)))?.targetBlogId).toBeNull()
    })
  })

  describe('the switch itself', () => {
    /** The card's own done-when. */
    it('cannot be switched on while no blog has been chosen', async () => {
      await connect([...SHOPIFY_READ_SCOPES, 'write_content'])
      const response = await call(route(makeSetDeliveryModeHandler), {
        method: 'POST',
        body: JSON.stringify({ delivery: 'auto' }),
      })
      expect(response.status).toBe(409)
      expect((await json(response)).error).toMatchObject({ code: 'target_blog_unresolved' })
      expect((await readAccountSettings(harness.db, accountScope(accountId))).delivery).toBe('export')
    })

    it('cannot be switched on without posting permission', async () => {
      await connect(SHOPIFY_READ_SCOPES)
      const response = await call(route(makeSetDeliveryModeHandler), {
        method: 'POST',
        body: JSON.stringify({ delivery: 'auto' }),
      })
      expect(response.status).toBe(409)
      expect((await json(response)).error).toMatchObject({ code: 'write_scope_required' })
      expect((await readAccountSettings(harness.db, accountScope(accountId))).delivery).toBe('export')
    })

    it('switches on once both are in place', async () => {
      await connect([...SHOPIFY_READ_SCOPES, 'write_content'])
      await call(route(makeSetTargetBlogHandler), {
        method: 'POST',
        body: JSON.stringify({ blogId: 'blog-1' }),
      })
      const response = await call(route(makeSetDeliveryModeHandler), {
        method: 'POST',
        body: JSON.stringify({ delivery: 'auto' }),
      })
      expect(response.status).toBe(200)
      expect((await readAccountSettings(harness.db, accountScope(accountId))).delivery).toBe('auto')
    })

    /** Withdrawing consent must work under every condition, including a broken connection. */
    it('always switches back off', async () => {
      await connect([...SHOPIFY_READ_SCOPES, 'write_content'])
      await call(route(makeSetTargetBlogHandler), {
        method: 'POST',
        body: JSON.stringify({ blogId: 'blog-1' }),
      })
      await call(route(makeSetDeliveryModeHandler), {
        method: 'POST',
        body: JSON.stringify({ delivery: 'auto' }),
      })
      await harness.db.delete(schema.shopifyConns)

      const response = await call(route(makeSetDeliveryModeHandler), {
        method: 'POST',
        body: JSON.stringify({ delivery: 'export' }),
      })
      expect(response.status).toBe(200)
      expect((await readAccountSettings(harness.db, accountScope(accountId))).delivery).toBe('export')
    })

    it('records whether posts go live or wait as Shopify drafts', async () => {
      await connect([...SHOPIFY_READ_SCOPES, 'write_content'])
      const response = await call(route(makeSetDeliveryModeHandler), {
        method: 'POST',
        body: JSON.stringify({ shopifyPublishAs: 'draft' }),
      })
      expect(response.status).toBe(200)
      expect((await readPublishTarget(harness.db, accountScope(accountId)))?.publishAs).toBe('draft')
    })
  })
})
