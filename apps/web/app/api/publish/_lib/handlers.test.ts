import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { SHOPIFY_READ_SCOPES } from '@sortiva/core'
import { accountScope, readAccountSettings, readPublishTarget, schema } from '@sortiva/db'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { FakeShopifyPublishClient } from '@sortiva/providers'
import { withAccount } from '../../auth/_lib/session'
import {
  makeListBlogsHandler,
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

describe.skipIf(!available)('turning auto-publish on', () => {
  let harness: TestDb
  let accountId: string
  let shop: FakeShopifyPublishClient

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
      cipher: {
        encrypt: (value) => `enc:${value}`,
        decrypt: (value) => value.replace(/^enc:/, ''),
      },
      stateSecret: 'test-secret',
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
