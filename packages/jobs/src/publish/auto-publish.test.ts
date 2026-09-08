import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { publishMarker, silentLogger } from '@sortiva/core'
import { accountScope, schema, setDeliveryMode, setTargetBlog, type Db } from '@sortiva/db'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import {
  FakeShopifyPublishClient,
  ShopifyApiFailure,
  ShopifyTokenInvalid,
} from '@sortiva/providers'
import { DbNotificationEmitter } from '../notify/emitter'
import { runExportDeliveryForAccount } from './deliver'
import { publishArticleToShopify } from './auto-publish'
import { republishArticleToShopify } from './republish'
import { sweepPublishRecovery } from './recovery'
import { RECOVERY_ABANDON_AFTER_MS, RECOVERY_GRACE_MS } from '@sortiva/core'

/**
 * Publishing to a merchant's shop, against a fake shop rather than a real one:
 * there is no Shopify development store in this environment. What the fake buys
 * is the thing a real store could not show — that a worker killed at the worst
 * possible instant leaves exactly one article behind, which is a statement
 * about every run rather than about the one that was watched.
 */

const available = await databaseAvailable()
const NOW = new Date('2026-09-03T09:00:00.000Z')
const TODAY = '2026-09-03'

describe.skipIf(!available)('posting an article to the merchant`s shop', () => {
  let ctx: TestDb
  let db: Db
  let accountId: string
  let shop: FakeShopifyPublishClient

  const cipher = { decrypt: (value: string) => value.replace(/^enc:/, '') }

  beforeAll(async () => {
    ctx = await setupTestDb('auto_publish')
    db = ctx.db as unknown as Db
  })

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(ctx.pool)
    accountId = await insertAccount(ctx.pool, 'auto@example.com')
    shop = new FakeShopifyPublishClient()
    await seedStore()
  })

  async function seedStore(): Promise<void> {
    await db.insert(schema.subscriptions).values({
      accountId,
      stripeSubscriptionId: 'sub_test',
      priceId: 'price_test',
      status: 'active',
    })
    await db.insert(schema.accountSettings).values({
      accountId,
      timezone: 'UTC',
      publishHour: 9,
      delivery: 'export',
    })
    // The domain the merchant claimed at signup — the host their shoppers
    // visit, and the one a published address is recorded under.
    await db.insert(schema.domains).values({ accountId, domainNormalized: 'acme.com' })
    await db.insert(schema.shopifyConns).values({
      accountId,
      shopHandle: 'acme',
      accessToken: 'enc:token',
      grantedScopes: ['read_products', 'read_content', 'write_content'],
    })
    await setTargetBlog(db, accountScope(accountId), { blogId: 'blog-1', blogHandle: 'news' })
    await setDeliveryMode(db, accountScope(accountId), 'auto')
  }

  /** A product the article mentions, at a price the store can change under it. */
  async function seedProduct(price: number): Promise<string> {
    const [product] = await db
      .insert(schema.products)
      .values({
        accountId,
        shopifyProductId: 'shopify-1',
        title: 'Steel bottle',
        variants: [{ price, available: true, compareAtPrice: null }],
        priceRange: { min: price, max: price, currency: 'USD' },
      })
      .returning()
    return product!.id
  }

  async function setPrice(productId: string, price: number): Promise<void> {
    await db
      .update(schema.products)
      .set({
        variants: [{ price, available: true, compareAtPrice: null }],
        priceRange: { min: price, max: price, currency: 'USD' },
      })
      .where(eq(schema.products.id, productId))
  }

  /** An article cleared for delivery, mentioning one product through a placeholder. */
  async function seedArticle(productId: string | null): Promise<string> {
    const [opportunity] = await db
      .insert(schema.opportunities)
      .values({
        accountId,
        signalType: 'uncovered_commercial_query',
        entityType: 'query_cluster',
        entityRef: 'bottles',
        evidenceJson: [],
        impact: 'medium',
        impactScore: 50,
        confidence: 50,
        reasonTemplateKey: 'opportunity.uncovered_commercial_query',
        reasonParamsJson: {},
        recommendedAction: 'create',
        status: 'scheduled',
        preconditionsJson: [],
        limitedIntelligence: false,
        rulesVersion: 'test',
      })
      .returning()
    const [topic] = await db
      .insert(schema.topics)
      .values({
        accountId,
        opportunityId: opportunity!.id,
        title: 'Best bottles',
        targetKeyword: 'best bottles',
        intentClass: 'buying_guide',
        kind: 'new',
        source: 'auto',
        scheduledDate: TODAY,
        state: 'generating',
      })
      .returning()
    await db
      .insert(schema.gateDecisions)
      .values({ accountId, topicId: topic!.id, gate: 3, outcome: 'passed', scoresJson: {}, rulesVersion: 'rules-test-v1' })
    const [article] = await db
      .insert(schema.articles)
      .values({
        accountId,
        topicId: topic!.id,
        title: 'Best bottles',
        slug: 'best-bottles',
        targetKeyword: 'best bottles',
        state: 'draft',
        metaDescription: 'How to choose a bottle.',
        bodyJson: {
          intro: 'The {{p1}} is the one to buy.',
          sections: [],
          faq: [],
        },
      })
      .returning()
    await db.insert(schema.articleProductRefs).values({
      articleId: article!.id,
      productId,
      refType: 'recommendation',
      placeholderKey: 'p1',
      fieldsRendered: ['price'],
    })
    return article!.id
  }

  function deps(over: { now?: () => Date; shopify?: FakeShopifyPublishClient; notifications?: DbNotificationEmitter } = {}) {
    return {
      db,
      pool: ctx.pool,
      shopify: over.shopify ?? shop,
      cipher,
      logger: silentLogger,
      now: over.now ?? (() => NOW),
      ...(over.notifications ? { notifications: over.notifications } : {}),
    }
  }

  async function intents() {
    return db
      .select()
      .from(schema.publishIntents)
      .where(eq(schema.publishIntents.accountId, accountId))
  }

  async function articleRow() {
    const [row] = await db
      .select()
      .from(schema.articles)
      .where(eq(schema.articles.accountId, accountId))
    return row!
  }

  it('posts the article at the publish hour and records where it went', async () => {
    const productId = await seedProduct(49.99)
    await seedArticle(productId)

    const result = await runExportDeliveryForAccount(deps(), { accountId, date: TODAY })

    expect(result).toEqual({ status: 'delivered', articleId: expect.any(String), delivery: 'auto' })
    expect(shop.articles.size).toBe(1)
    const row = await articleRow()
    expect(row.state).toBe('published')
    expect(row.delivery).toBe('auto')
    expect(row.publishedUrl).toContain('best-bottles')

    const claims = await intents()
    expect(claims).toHaveLength(1)
    expect(claims[0]!.state).toBe('confirmed')
    expect(claims[0]!.shopifyArticleId).toBe([...shop.articles.keys()][0])
  })

  /**
   * The done-when: a price changed between the article being written and it
   * being published appears at its new value. The article body never held the
   * figure; it held a marker, and the figure is read from the store now.
   */
  it('posts the price the store asks today, not the one it asked when the article was written', async () => {
    const productId = await seedProduct(49.99)
    await seedArticle(productId)

    await setPrice(productId, 59.5)

    await runExportDeliveryForAccount(deps(), { accountId, date: TODAY })

    const posted = [...shop.articles.values()][0]!
    expect(posted.bodyHtml).toContain('59.50 USD')
    expect(posted.bodyHtml).not.toContain('49.99')
  })

  /**
   * The other done-when: a product that has gone stops the publish. Posting the
   * sentence without the product would put an article with a hole in it on the
   * merchant's own site.
   */
  it('refuses to post an article naming a product the store no longer has', async () => {
    const productId = await seedProduct(49.99)
    const articleId = await seedArticle(productId)

    // `ON DELETE SET NULL` on the reference: the row survives the product so
    // there is something to raise a repair against.
    await db.delete(schema.products).where(eq(schema.products.id, productId))

    const result = await publishArticleToShopify(deps(), { accountId, articleId })

    expect(result).toEqual({
      status: 'failed',
      reason: 'product_gone',
      detail: expect.stringContaining('p1'),
    })
    expect(shop.articles.size).toBe(0)
    // Nothing was claimed either, so no recovery sweep goes looking for it.
    expect(await intents()).toEqual([])
    expect((await articleRow()).state).toBe('draft')
  })

  it('will not post for a store that has withdrawn posting permission', async () => {
    const productId = await seedProduct(49.99)
    const articleId = await seedArticle(productId)
    await db
      .update(schema.shopifyConns)
      .set({ grantedScopes: ['read_products'] })
      .where(eq(schema.shopifyConns.accountId, accountId))

    expect(await publishArticleToShopify(deps(), { accountId, articleId })).toEqual({
      status: 'skipped',
      reason: 'write_scope_required',
    })
    expect(shop.articles.size).toBe(0)
  })

  it('posts as a Shopify draft when the merchant asked for one, and gives no reader address', async () => {
    const productId = await seedProduct(49.99)
    const articleId = await seedArticle(productId)
    await db
      .update(schema.accountSettings)
      .set({ shopifyPublishAs: 'draft' })
      .where(eq(schema.accountSettings.accountId, accountId))

    await publishArticleToShopify(deps(), { accountId, articleId })

    const posted = [...shop.articles.values()][0]!
    expect(posted.published).toBe(false)
    expect((await articleRow()).publishedUrl).toBeNull()
  })

  describe('a worker killed between posting and recording it', () => {
    /**
     * The instant the whole protocol exists for. The post is on the shop and
     * nothing of ours knows. What must not happen next is a second post.
     */
    async function publishThenDie(articleId: string): Promise<void> {
      await expect(
        publishArticleToShopify(
          {
            ...deps(),
            checkpoint: (label) => {
              if (label === 'publish:executed') throw new Error('worker killed')
            },
          },
          { accountId, articleId },
        ),
      ).rejects.toThrow('worker killed')
    }

    it('leaves one post on the shop and a claim nobody has answered', async () => {
      const productId = await seedProduct(49.99)
      const articleId = await seedArticle(productId)
      await publishThenDie(articleId)

      expect(shop.articles.size).toBe(1)
      const claims = await intents()
      expect(claims[0]!.state).toBe('pending')
      expect(claims[0]!.shopifyArticleId).toBeNull()
      // And the article is not claiming to be published, because it is not
      // recorded anywhere that it is.
      expect((await articleRow()).state).toBe('draft')
    })

    it('adopts the post the sweep finds rather than making a second one', async () => {
      const productId = await seedProduct(49.99)
      const articleId = await seedArticle(productId)
      await publishThenDie(articleId)

      const later = new Date(Date.now() + RECOVERY_GRACE_MS + 1000)
      const summary = await sweepPublishRecovery(deps({ now: () => later }))

      expect(summary).toMatchObject({ considered: 1, adopted: 1, reExecuted: 0 })
      expect(shop.countByMarker(publishMarker(articleId))).toBe(1)
      expect(shop.calls.filter((c) => c.op === 'create')).toHaveLength(1)

      const claims = await intents()
      expect(claims[0]!.state).toBe('confirmed')
      const row = await articleRow()
      expect(row.state).toBe('published')
      expect(row.delivery).toBe('auto')
    })

    it('never re-sends without first asking the shop', async () => {
      const productId = await seedProduct(49.99)
      const articleId = await seedArticle(productId)
      await publishThenDie(articleId)
      shop.calls.length = 0

      const later = new Date(Date.now() + RECOVERY_GRACE_MS + 1000)
      await sweepPublishRecovery(deps({ now: () => later }))

      // The question comes before any decision to write.
      expect(shop.calls[0]!.op).toBe('find')
    })

    it('sends the post when the shop says it never landed', async () => {
      const productId = await seedProduct(49.99)
      const articleId = await seedArticle(productId)
      shop.failNextWith = new Error('shopify is down')
      // We do not know whether the post landed, so the claim is kept and the
      // sweep is left to ask the shop rather than anything deciding here.
      expect(await publishArticleToShopify(deps(), { accountId, articleId })).toMatchObject({
        status: 'failed',
        reason: 'shop_unreachable',
      })
      expect(shop.articles.size).toBe(0)
      expect((await intents())[0]!.state).toBe('pending')

      const later = new Date(Date.now() + RECOVERY_GRACE_MS + 1000)
      const summary = await sweepPublishRecovery(deps({ now: () => later }))

      expect(summary).toMatchObject({ adopted: 0, reExecuted: 1 })
      expect(shop.countByMarker(publishMarker(articleId))).toBe(1)
      expect((await articleRow()).state).toBe('published')
    })

    it('leaves a claim too young to be interrupted alone', async () => {
      const productId = await seedProduct(49.99)
      const articleId = await seedArticle(productId)
      await publishThenDie(articleId)
      shop.calls.length = 0

      const summary = await sweepPublishRecovery(deps({ now: () => new Date() }))
      expect(summary.considered).toBe(0)
      expect(shop.calls).toEqual([])
    })

    it('gives up after three sweeps and leaves the work where a person will see it', async () => {
      const productId = await seedProduct(49.99)
      const articleId = await seedArticle(productId)
      shop.failNextWith = new Error('shopify is down')
      await publishArticleToShopify(deps(), { accountId, articleId })

      const later = new Date(Date.now() + RECOVERY_ABANDON_AFTER_MS + 1000)
      const summary = await sweepPublishRecovery(deps({ now: () => later }))

      expect(summary).toMatchObject({ abandoned: 1 })
      expect((await intents())[0]!.state).toBe('abandoned')
      const dlq = await db.select().from(schema.jobDlq).where(eq(schema.jobDlq.accountId, accountId))
      expect(dlq).toHaveLength(1)
      expect(dlq[0]!.idempotencyKey).toContain(articleId)
      expect(shop.articles.size).toBe(0)
    })
  })

  /**
   * The four defects `R-PUBLISH` fixed, each proved by the thing it broke.
   */
  describe('when the shop is bigger, or slower, or has stopped trusting us', () => {
    /**
     * The duplicate post. The recovery sweep asks the shop whether our article
     * is already there; on a blog holding more posts than fit in one response,
     * that question used to be asked of the first page only, and the answer
     * "no" is what authorises posting the article a second time.
     */
    it('finds our post on a blog that holds more than one page of articles', async () => {
      const bigBlog = new FakeShopifyPublishClient(
        [{ id: 'blog-1', title: 'News', handle: 'news' }],
        { pageSize: 2 },
      )
      const productId = await seedProduct(49.99)
      const articleId = await seedArticle(productId)

      // The merchant's own posts, written just before ours, so ours is not on
      // the first page the sweep reads.
      for (let i = 0; i < 5; i += 1) {
        bigBlog.plantArticle({
          blogId: 'blog-1',
          blogHandle: 'news',
          shop: 'acme',
          handle: `merchant-post-${i}`,
          createdAt: new Date(Date.now() - 60_000),
        })
      }

      await expect(
        publishArticleToShopify(
          {
            ...deps({ shopify: bigBlog }),
            checkpoint: (label: string) => {
              if (label === 'publish:executed') throw new Error('worker killed')
            },
          },
          { accountId, articleId },
        ),
      ).rejects.toThrow('worker killed')

      const later = new Date(Date.now() + RECOVERY_GRACE_MS + 1000)
      const summary = await sweepPublishRecovery(deps({ shopify: bigBlog, now: () => later }))

      expect(summary).toMatchObject({ adopted: 1, reExecuted: 0 })
      expect(bigBlog.countByMarker(publishMarker(articleId))).toBe(1)
      expect(bigBlog.calls.filter((c) => c.op === 'create')).toHaveLength(1)
      // And it really paged rather than peeking at the first response.
      expect(bigBlog.calls.filter((c) => c.op === 'list_page').length).toBeGreaterThan(1)
      expect((await articleRow()).state).toBe('published')
    })

    /**
     * The stranded article. A shop that turns us away for a moment used to
     * leave the claim on the publication open, so every later attempt collided
     * with it and reported "already claimed" — for ever.
     */
    it('leaves the article due again after the shop turns a post away', async () => {
      const productId = await seedProduct(49.99)
      const articleId = await seedArticle(productId)
      shop.failNextWith = new ShopifyApiFailure('Shopify rate-limited us.', { retryAfterMs: 2000 })

      const refused = await publishArticleToShopify(deps(), { accountId, articleId })

      expect(refused).toMatchObject({ status: 'failed', reason: 'shop_refused' })
      expect(shop.articles.size).toBe(0)
      // Nothing is holding the publication, which is what makes it retryable.
      expect(await intents()).toEqual([])
      expect((await articleRow()).state).toBe('draft')

      const second = await publishArticleToShopify(deps(), { accountId, articleId })

      expect(second).toMatchObject({ status: 'published' })
      expect(shop.countByMarker(publishMarker(articleId))).toBe(1)
      expect((await articleRow()).state).toBe('published')
    })

    /**
     * The silence. A merchant whose Shopify permission has been withdrawn is
     * the only person who can fix it, and the product already knows how to ask
     * them — it just was not asked from here.
     */
    it('raises the reconnect the rest of the product raises when the token is rejected', async () => {
      const productId = await seedProduct(49.99)
      const articleId = await seedArticle(productId)
      shop.failNextWith = new ShopifyTokenInvalid('acme', 401)

      const result = await publishArticleToShopify(
        deps({ notifications: new DbNotificationEmitter(db) }),
        { accountId, articleId },
      )

      expect(result).toEqual({ status: 'skipped', reason: 'connection_lost' })

      const [connection] = await db
        .select()
        .from(schema.shopifyConns)
        .where(eq(schema.shopifyConns.accountId, accountId))
      expect(connection!.invalidatedAt).not.toBeNull()

      const bell = await db
        .select()
        .from(schema.notifications)
        .where(eq(schema.notifications.accountId, accountId))
      expect(bell.map((row) => row.type)).toContain('connection_lost_shopify')

      // And nothing is left holding the publication, so it goes out once the
      // merchant has reconnected.
      expect(await intents()).toEqual([])
    })

    /**
     * The same defect from the other side. If the search cannot finish, the
     * one thing it must not do is answer "not there" — that answer is what
     * authorises posting the article again.
     */
    it('posts nothing a second time when the shop could not be fully asked', async () => {
      const hugeBlog = new FakeShopifyPublishClient(
        [{ id: 'blog-1', title: 'News', handle: 'news' }],
        { pageSize: 2, maxLookupPages: 1 },
      )
      const productId = await seedProduct(49.99)
      const articleId = await seedArticle(productId)
      for (let i = 0; i < 6; i += 1) {
        hugeBlog.plantArticle({
          blogId: 'blog-1',
          blogHandle: 'news',
          shop: 'acme',
          handle: `merchant-post-${i}`,
          createdAt: new Date(Date.now() - 60_000),
        })
      }

      await expect(
        publishArticleToShopify(
          {
            ...deps({ shopify: hugeBlog }),
            checkpoint: (label: string) => {
              if (label === 'publish:executed') throw new Error('worker killed')
            },
          },
          { accountId, articleId },
        ),
      ).rejects.toThrow('worker killed')

      const later = new Date(Date.now() + RECOVERY_GRACE_MS + 1000)
      const summary = await sweepPublishRecovery(deps({ shopify: hugeBlog, now: () => later }))

      expect(summary).toMatchObject({ adopted: 0, reExecuted: 0, skipped: 1 })
      expect(hugeBlog.countByMarker(publishMarker(articleId))).toBe(1)
      expect(hugeBlog.calls.filter((c) => c.op === 'create')).toHaveLength(1)
      // The claim is still open, so the sweep will ask again rather than the
      // question being closed on an answer nobody had.
      expect((await intents())[0]!.state).toBe('pending')
    })

    /** The wrong address: Shopify serves a post under the blog\'s name, not its number. */
    it('records the address the blog is actually served at', async () => {
      const productId = await seedProduct(49.99)
      await seedArticle(productId)

      await runExportDeliveryForAccount(deps(), { accountId, date: TODAY })

      const url = (await articleRow()).publishedUrl
      expect(url).toContain('/blogs/news/')
      expect(url).not.toContain('/blogs/blog-1/')
    })

    /**
     * The address has to be the one shoppers use, or Search Console can never
     * match the article to the clicks it earns and a ranking article looks
     * like it earned nothing for ever.
     */
    it('records the store`s own domain rather than its myshopify host', async () => {
      const productId = await seedProduct(49.99)
      await seedArticle(productId)

      await runExportDeliveryForAccount(deps(), { accountId, date: TODAY })

      const url = (await articleRow()).publishedUrl
      expect(url).toBe('https://acme.com/blogs/news/best-bottles')
      expect(url).not.toContain('myshopify')
    })
  })

  describe('revising an article we already posted', () => {
    async function publishOnce(): Promise<{ articleId: string; productId: string }> {
      const productId = await seedProduct(49.99)
      const articleId = await seedArticle(productId)
      await publishArticleToShopify(deps(), { accountId, articleId })
      return { articleId, productId }
    }

    it('updates the post in place and creates nothing', async () => {
      const { articleId, productId } = await publishOnce()
      await setPrice(productId, 61)

      const result = await republishArticleToShopify(deps(), { accountId, articleId, revisionN: 1 })

      expect(result.status).toBe('updated')
      expect(shop.articles.size).toBe(1)
      expect(shop.calls.filter((c) => c.op === 'create')).toHaveLength(1)
      expect([...shop.articles.values()][0]!.bodyHtml).toContain('61.00 USD')
    })

    /**
     * The done-when, and the single rule an automated publisher must never
     * break: the merchant deleted the article, so nothing puts it back.
     */
    it('creates nothing when the merchant deleted the post, and says so', async () => {
      const { articleId } = await publishOnce()
      shop.articles.clear()

      const result = await republishArticleToShopify(deps(), { accountId, articleId, revisionN: 1 })

      expect(result).toEqual({
        status: 'failed',
        reason: 'remote_article_gone',
        detail: expect.any(String),
      })
      expect(shop.articles.size).toBe(0)
      expect(shop.calls.filter((c) => c.op === 'create')).toHaveLength(1)
      // The revision's claim is closed, so no sweep tries it again.
      const revision = (await intents()).find((row) => row.revisionN === 1)
      expect(revision!.state).toBe('abandoned')
    })

    /**
     * The whole of decision (a), end to end: the merchant renamed our post,
     * put their own tags on it and took it down, and a repair — which now runs
     * on a schedule, with nobody clicking anything — leaves all three exactly
     * as they left them.
     */
    it('leaves the merchant`s rename, their tags and their unpublish alone', async () => {
      const { articleId, productId } = await publishOnce()
      const remoteId = [...shop.articles.keys()][0]!
      shop.articles.set(remoteId, {
        ...shop.articles.get(remoteId)!,
        handle: 'their-own-name',
        tags: ['seasonal', 'staff-picks'],
        published: false,
        url: null,
      })
      await setPrice(productId, 61)

      const result = await republishArticleToShopify(deps(), { accountId, articleId, revisionN: 1 })

      expect(result.status).toBe('updated')
      const after = shop.articles.get(remoteId)!
      expect(after.handle).toBe('their-own-name')
      expect(after.tags).toEqual(['seasonal', 'staff-picks'])
      expect(after.published).toBe(false)
      // What we did change: the words.
      expect(after.bodyHtml).toContain('61.00 USD')
    })

    /**
     * Articles posted before the address changed keep the address they were
     * posted under. Re-addressing them would silently move where a merchant
     * believes their article lives, on no evidence that the new address is the
     * one that was ever served.
     */
    it('never re-addresses an article that was published before', async () => {
      const { articleId, productId } = await publishOnce()
      const oldAddress = 'https://acme.myshopify.com/blogs/news/best-bottles'
      await db
        .update(schema.articles)
        .set({ publishedUrl: oldAddress })
        .where(eq(schema.articles.id, articleId))
      await setPrice(productId, 61)

      const result = await republishArticleToShopify(deps(), { accountId, articleId, revisionN: 1 })

      expect(result.status).toBe('updated')
      expect((await articleRow()).publishedUrl).toBe(oldAddress)
    })

    it('refuses to revise an article that was never posted', async () => {
      const productId = await seedProduct(49.99)
      const articleId = await seedArticle(productId)

      expect(await republishArticleToShopify(deps(), { accountId, articleId, revisionN: 1 })).toEqual(
        { status: 'skipped', reason: 'never_published' },
      )
      expect(shop.articles.size).toBe(0)
    })
  })
})
