import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import {
  attentionSourcesFor,
  buildAttentionList,
  readRepairOutcome,
  silentLogger,
  staticShopifyAuth,
} from '@sortiva/core'
import {
  accountScope,
  makeNotificationStore,
  openRepairs,
  repairHistory,
  schema,
  setDeliveryMode,
  setTargetBlog,
  type Db
} from '@sortiva/db'
import {
  databaseAvailable,
  insertAccount,
  setupTestDb,
  truncateAll,
  type TestDb,
  nextFixtureDay,
} from '@sortiva/db/testing'
import { FakeShopifyPublishClient } from '@sortiva/providers'
import { rules } from '@sortiva/rules'
import { runDriftPassForAccount } from './sweep'

/**
 * The daily check on what we have already published, end to end against a real
 * database and a fake shop.
 *
 * The four things it has to get right, and each of them is a promise to a
 * merchant rather than a property of the code: a product they withdraw is
 * noticed on every page that names it; a price they change costs them nothing
 * at all; a store that publishes for itself is never written to; and a store
 * that asked us to publish gets the corrected article back on its blog through
 * the same claim-send-confirm protocol as any other publication.
 */

const available = await databaseAvailable()
const NOW = new Date('2026-09-20T09:00:00.000Z')
const TODAY = '2026-09-20'

describe.skipIf(!available)('the daily check on published articles', () => {
  let ctx: TestDb
  let db: Db
  let accountId: string
  let shop: FakeShopifyPublishClient

  /**
   * How a call reaches this store. A token is asked for per request rather
   * than decrypted once, because a repair can outlast the hour a Shopify token
   * lives; nothing in these tests renews one, so it answers the same every time.
   */
  const authFor = async () => staticShopifyAuth('acme', 'token')

  beforeAll(async () => {
    ctx = await setupTestDb('drift')
    db = ctx.db as unknown as Db
  })

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(ctx.pool)
    accountId = await insertAccount(ctx.pool, 'drift@example.com')
    shop = new FakeShopifyPublishClient()
    await db.insert(schema.subscriptions).values({
      accountId,
      stripeSubscriptionId: 'sub_test',
      priceId: 'price_test',
      status: 'active',
    })
    await db
      .insert(schema.accountSettings)
      .values({ accountId, timezone: 'UTC', publishHour: 9, delivery: 'export' })
  })

  function deps() {
    return {
      db,
      pool: ctx.pool,
      shopify: shop,
      authFor,
      logger: silentLogger,
      now: () => NOW,
    }
  }

  async function grantPublishing(): Promise<void> {
    await db.insert(schema.shopifyConns).values({
      accountId,
      shopHandle: 'acme',
      accessToken: 'enc:token',
      grantedScopes: ['read_products', 'read_content', 'write_content'],
    })
    await setTargetBlog(db, accountScope(accountId), { blogId: 'blog-1', blogHandle: 'news' })
    await setDeliveryMode(db, accountScope(accountId), 'auto')
  }

  async function seedFamily(axes: readonly string[] = ['capacity']): Promise<string> {
    const [family] = await db
      .insert(schema.productFamilies)
      .values({
        accountId,
        name: 'Bottles',
        differentiationAxes: [...axes],
        groupingSource: 'collection',
        confidence: 'high',
      })
      .returning()
    return family!.id
  }

  async function seedProduct(input: {
    shopifyId: string
    title: string
    familyId: string
    available?: boolean
    facts?: Record<string, unknown>
  }): Promise<string> {
    const [product] = await db
      .insert(schema.products)
      .values({
        accountId,
        shopifyProductId: input.shopifyId,
        title: input.title,
        familyId: input.familyId,
        variants: [{ price: 49.99, available: input.available ?? true, compareAtPrice: null }],
        priceRange: { min: 49.99, max: 49.99, currency: 'USD' },
      })
      .returning()
    await db.insert(schema.productFacts).values({
      productId: product!.id,
      factsJson: input.facts ?? { material: 'steel', capacity: '750ml', lid: 'screw' },
      factCount: 3,
      promptVersion: 'v1',
      modelId: 'test',
    })
    return product!.id
  }

  /** A published article naming one product through a placeholder. */
  async function seedPublishedArticle(input: {
    productId: string
    slug?: string
    headings?: readonly string[]
    remoteArticleId?: string
  }): Promise<string> {
    const [opportunity] = await db
      .insert(schema.opportunities)
      .values({
        accountId,
        signalType: 'uncovered_commercial_query',
        entityType: 'query_cluster',
        entityRef: `bottles-${input.slug ?? 'best-bottles'}`,
        evidenceJson: [],
        impact: 'medium',
        impactScore: 50,
        confidence: 50,
        reasonTemplateKey: 'opportunity.uncovered_commercial_query',
        reasonParamsJson: {},
        recommendedAction: 'create',
        status: 'completed',
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
        scheduledDate: nextFixtureDay(TODAY),
        state: 'published',
      })
      .returning()
    const [article] = await db
      .insert(schema.articles)
      .values({
        accountId,
        topicId: topic!.id,
        title: 'Best bottles',
        slug: input.slug ?? 'best-bottles',
        targetKeyword: 'best bottles',
        state: 'published',
        delivery: 'auto',
        publishedUrl: 'https://acme.example/blogs/news/best-bottles',
        publishedAt: new Date('2026-09-01T09:00:00.000Z'),
        metaDescription: 'How to choose a bottle.',
        bodyJson: {
          intro: 'The {{p1}} is the one to buy.',
          sections: (input.headings ?? []).map((heading) => ({ heading, body: 'x' })),
          faq: [],
        },
      })
      .returning()
    await db.insert(schema.articleProductRefs).values({
      articleId: article!.id,
      productId: input.productId,
      familyId: null,
      refType: 'recommendation',
      placeholderKey: 'p1',
      fieldsRendered: ['price'],
    })
    if (input.remoteArticleId) {
      await db.insert(schema.publishIntents).values({
        accountId,
        articleExternalId: `sortiva-${article!.id}`,
        revisionN: 0,
        state: 'confirmed',
        shopifyArticleId: input.remoteArticleId,
        confirmedAt: new Date('2026-09-01T09:00:00.000Z'),
      })
    }
    return article!.id
  }

  /** What the store told us it changed, as the shared record holds it. */
  async function recordChange(input: {
    kind: string
    entityId: string
    occurredAt: string
    receivedAt?: Date
  }): Promise<void> {
    await db.insert(schema.webhookEvents).values({
      webhookId: `catalog_change/${accountId}:${input.kind}:${input.entityId}:${input.occurredAt}`,
      source: 'shopify',
      topic: `catalog_change/${input.kind}`,
      payload: {
        account_id: accountId,
        shop_handle: 'acme',
        kind: input.kind,
        entity_id: input.entityId,
        occurred_at: input.occurredAt,
        changed_fields: [],
      },
      status: 'processed',
      receivedAt: input.receivedAt ?? new Date('2026-09-19T00:00:00.000Z'),
      processedAt: new Date('2026-09-19T00:00:00.000Z'),
    })
  }

  async function refRow(articleId: string) {
    const [row] = await db
      .select()
      .from(schema.articleProductRefs)
      .where(eq(schema.articleProductRefs.articleId, articleId))
    return row!
  }

  async function opportunityFor(articleId: string) {
    const [row] = await db
      .select()
      .from(schema.opportunities)
      .where(
        and(
          eq(schema.opportunities.accountId, accountId),
          eq(schema.opportunities.entityType, 'article'),
          eq(schema.opportunities.entityRef, articleId),
        ),
      )
    return row
  }

  it('flags every article that names a withdrawn product, in one pass', async () => {
    const familyId = await seedFamily()
    const goneId = await seedProduct({ shopifyId: 'shopify-gone', title: 'Steel bottle 750', familyId })
    const first = await seedPublishedArticle({ productId: goneId, slug: 'a' })
    const second = await seedPublishedArticle({ productId: goneId, slug: 'b' })
    await recordChange({ kind: 'product_deleted', entityId: 'shopify-gone', occurredAt: '2026-09-19T00:00:00.000Z' })

    const result = await runDriftPassForAccount(deps(), { accountId })

    expect(result.articlesChecked).toBe(2)
    expect(result.driftFound).toBe(2)
    const open = await openRepairs(db, accountScope(accountId))
    expect(open.map((row) => row.articleId).sort()).toEqual([first, second].sort())
    for (const row of open) {
      expect(row.signalType).toBe('broken_product_reference')
    }
  })

  it('carries the evidence behind the card, stamped with where it came from', async () => {
    const familyId = await seedFamily()
    const goneId = await seedProduct({ shopifyId: 'shopify-gone', title: 'Steel bottle 750', familyId })
    await seedProduct({ shopifyId: 'shopify-alt', title: 'Steel bottle 1000', familyId })
    const articleId = await seedPublishedArticle({ productId: goneId })
    await recordChange({ kind: 'product_deleted', entityId: 'shopify-gone', occurredAt: '2026-09-19T00:00:00.000Z' })

    await runDriftPassForAccount(deps(), { accountId })

    const opportunity = await opportunityFor(articleId)
    const evidence = opportunity!.evidenceJson as { key: string; source: string }[]
    expect(evidence.map((fact) => fact.key)).toContain('drift_kind')
    expect(evidence.every((fact) => fact.source === 'catalog')).toBe(true)
    expect(opportunity!.rulesVersion).not.toBe('')
    expect(opportunity!.status).toBe('accepted')

    const [task] = await db
      .select()
      .from(schema.opportunityTasks)
      .where(eq(schema.opportunityTasks.opportunityId, opportunity!.id))
    expect(task!.kind).toBe('repair_reference')
  })

  it('re-detecting the same broken article updates the card rather than adding one', async () => {
    const familyId = await seedFamily()
    const goneId = await seedProduct({ shopifyId: 'shopify-gone', title: 'Steel bottle 750', familyId })
    await seedPublishedArticle({ productId: goneId })
    await recordChange({ kind: 'product_deleted', entityId: 'shopify-gone', occurredAt: '2026-09-19T00:00:00.000Z' })

    await runDriftPassForAccount(deps(), { accountId })
    await runDriftPassForAccount(deps(), { accountId })

    const open = await openRepairs(db, accountScope(accountId))
    expect(open).toHaveLength(1)
  })

  it('a price change queues no rewrite and takes no day off the calendar', async () => {
    const familyId = await seedFamily()
    const productId = await seedProduct({ shopifyId: 'shopify-1', title: 'Steel bottle 750', familyId })
    await seedPublishedArticle({ productId })

    // Tomorrow's article, sitting on the calendar untouched.
    const [opportunity] = await db
      .insert(schema.opportunities)
      .values({
        accountId,
        signalType: 'uncovered_commercial_query',
        entityType: 'query_cluster',
        entityRef: 'tomorrow',
        evidenceJson: [],
        impact: 'medium',
        impactScore: 50,
        confidence: 50,
        reasonTemplateKey: 'opportunity.uncovered_commercial_query',
        reasonParamsJson: {},
        recommendedAction: 'create',
        status: 'accepted',
        preconditionsJson: [],
        limitedIntelligence: false,
        rulesVersion: 'test',
      })
      .returning()
    const [tomorrow] = await db
      .insert(schema.topics)
      .values({
        accountId,
        opportunityId: opportunity!.id,
        title: 'Bottles for hiking',
        intentClass: 'buying_guide',
        kind: 'new',
        source: 'auto',
        scheduledDate: '2026-09-21',
        state: 'planned',
      })
      .returning()

    // The merchant drops the price by a third, and the store tells us.
    await db
      .update(schema.products)
      .set({
        variants: [{ price: 29.99, available: true, compareAtPrice: 49.99 }],
        priceRange: { min: 29.99, max: 29.99, currency: 'USD' },
      })
      .where(eq(schema.products.id, productId))
    await recordChange({ kind: 'price_changed', entityId: 'shopify-1', occurredAt: '2026-09-19T00:00:00.000Z' })

    const result = await runDriftPassForAccount(deps(), { accountId })

    expect(result.driftFound).toBe(0)
    expect(result.rewritesQueued).toBe(0)
    expect(await openRepairs(db, accountScope(accountId))).toEqual([])

    const [after] = await db
      .select()
      .from(schema.topics)
      .where(eq(schema.topics.id, tomorrow!.id))
    expect(after!.state).toBe('planned')
    expect(after!.scheduledDate).toBe('2026-09-21')
    expect(after!.title).toBe('Bottles for hiking')
  })

  it('hands an export-mode store a card and writes nothing to any shop', async () => {
    const familyId = await seedFamily()
    const goneId = await seedProduct({ shopifyId: 'shopify-gone', title: 'Steel bottle 750', familyId })
    await seedProduct({ shopifyId: 'shopify-alt', title: 'Steel bottle 1000', familyId })
    const articleId = await seedPublishedArticle({ productId: goneId })
    await recordChange({ kind: 'product_deleted', entityId: 'shopify-gone', occurredAt: '2026-09-19T00:00:00.000Z' })

    const result = await runDriftPassForAccount(deps(), { accountId })

    expect(result.cardsRaised).toBe(1)
    expect(result.repairedAutomatically).toBe(0)
    expect(shop.calls).toEqual([])
    expect(shop.articles.size).toBe(0)

    // The card stands until the merchant replaces the live page themselves.
    const open = await openRepairs(db, accountScope(accountId))
    expect(open).toHaveLength(1)

    // And their own copy is mended, so the download the card offers is the
    // repaired article rather than the broken one.
    const ref = await refRow(articleId)
    expect(ref.productId).not.toBe(goneId)
    const history = await repairHistory(db, accountScope(accountId), articleId)
    expect(readRepairOutcome(history[0]!.outcome)?.references[0]).toMatchObject({
      fromProductTitle: 'Steel bottle 750',
      toProductTitle: 'Steel bottle 1000',
    })
  })

  it('mends and republishes for a store that asked us to publish', async () => {
    await grantPublishing()
    const familyId = await seedFamily()
    const goneId = await seedProduct({ shopifyId: 'shopify-gone', title: 'Steel bottle 750', familyId })
    await seedProduct({ shopifyId: 'shopify-alt', title: 'Steel bottle 1000', familyId })
    const remote = await shop.createArticle({
      auth: staticShopifyAuth('acme', 'token'),
      blogId: 'blog-1',
      storefrontDomain: 'acme.com',
      title: 'Best bottles',
      bodyHtml: '<p>The Steel bottle 750 is the one to buy.</p>',
      handle: 'best-bottles',
      summary: 'How to choose a bottle.',
      author: 'Acme',
      marker: 'seeded',
      publishAs: 'live',
    })
    const articleId = await seedPublishedArticle({ productId: goneId, remoteArticleId: remote.id })
    await recordChange({ kind: 'product_deleted', entityId: 'shopify-gone', occurredAt: '2026-09-19T00:00:00.000Z' })
    // Everything above stands in for the first publication, weeks ago. Only
    // what the repair itself asks of the shop is under test.
    shop.calls.length = 0

    const result = await runDriftPassForAccount(deps(), { accountId })

    expect(result.repairedAutomatically).toBe(1)

    // Through the claim protocol, with its own revision, and as an update to
    // the article we already published — never as a second post.
    const updates = shop.calls.filter((call) => call.op === 'update')
    expect(updates).toHaveLength(1)
    const creates = shop.calls.filter((call) => call.op === 'create')
    expect(creates).toHaveLength(0)
    const intents = await db
      .select()
      .from(schema.publishIntents)
      .where(eq(schema.publishIntents.accountId, accountId))
    const revision = intents.find((intent) => intent.revisionN === 1)
    expect(revision?.state).toBe('confirmed')
    expect(revision?.shopifyArticleId).toBe(remote.id)

    // The article on the shop now names the replacement.
    expect(shop.articles.get(remote.id)?.bodyHtml).toContain('Steel bottle 1000')

    // The repair is over, logged with what it changed, and off the merchant's list.
    expect(await openRepairs(db, accountScope(accountId))).toEqual([])
    const history = await repairHistory(db, accountScope(accountId), articleId)
    const record = readRepairOutcome(history[0]!.outcome)
    expect(record?.route).toBe('mechanical_auto')
    expect(record?.revisionN).toBe(1)
    expect(record?.references[0]).toMatchObject({
      fromProductTitle: 'Steel bottle 750',
      toProductTitle: 'Steel bottle 1000',
    })
  })

  it('sends an article to be rewritten when nothing in the range can stand in', async () => {
    await grantPublishing()
    const familyId = await seedFamily()
    const goneId = await seedProduct({ shopifyId: 'shopify-gone', title: 'Steel bottle 750', familyId })
    // The only other product in the range shares almost nothing with it.
    await seedProduct({
      shopifyId: 'shopify-alt',
      title: 'Enamel mug',
      familyId,
      facts: { colour: 'blue' },
    })
    const articleId = await seedPublishedArticle({ productId: goneId })
    await recordChange({ kind: 'product_deleted', entityId: 'shopify-gone', occurredAt: '2026-09-19T00:00:00.000Z' })

    const result = await runDriftPassForAccount(deps(), { accountId })

    expect(result.rewritesQueued).toBe(1)
    expect(shop.calls.filter((call) => call.op === 'update')).toEqual([])
    const opportunity = await opportunityFor(articleId)
    expect(opportunity!.recommendedAction).toBe('refresh')
    expect(opportunity!.status).toBe('accepted')
    // Nothing was swapped: the mention still names the product that went, and
    // the rewrite is what will deal with it.
    expect((await refRow(articleId)).productId).toBe(goneId)
  })

  it("puts the open repair on the dashboard's needs-you list", async () => {
    const familyId = await seedFamily()
    const goneId = await seedProduct({ shopifyId: 'shopify-gone', title: 'Steel bottle 750', familyId })
    await seedProduct({ shopifyId: 'shopify-alt', title: 'Steel bottle 1000', familyId })
    const articleId = await seedPublishedArticle({ productId: goneId })
    await recordChange({ kind: 'product_deleted', entityId: 'shopify-gone', occurredAt: '2026-09-19T00:00:00.000Z' })

    await runDriftPassForAccount(deps(), { accountId })

    const store = makeNotificationStore({ database: db })
    const items = await buildAttentionList(attentionSourcesFor(store, accountId), NOW)
    const repair = items.find((item) => item.kind === 'repair_pending')
    expect(repair?.refs.article_id).toBe(articleId)
  })

  it('finishes a repair a crash interrupted after the mend and before the post', async () => {
    await grantPublishing()
    const familyId = await seedFamily()
    const goneId = await seedProduct({ shopifyId: 'shopify-gone', title: 'Steel bottle 750', familyId })
    await seedProduct({ shopifyId: 'shopify-alt', title: 'Steel bottle 1000', familyId })
    const remote = await shop.createArticle({
      auth: staticShopifyAuth('acme', 'token'),
      blogId: 'blog-1',
      storefrontDomain: 'acme.com',
      title: 'Best bottles',
      bodyHtml: '<p>The Steel bottle 750 is the one to buy.</p>',
      handle: 'best-bottles',
      summary: 'How to choose a bottle.',
      author: 'Acme',
      marker: 'seeded',
      publishAs: 'live',
    })
    const articleId = await seedPublishedArticle({ productId: goneId, remoteArticleId: remote.id })
    await recordChange({ kind: 'product_deleted', entityId: 'shopify-gone', occurredAt: '2026-09-19T00:00:00.000Z' })
    shop.calls.length = 0

    // The worker dies the instant our copy is mended. From here on nothing
    // looking at the store can tell a repair was ever needed: the mention names
    // a product that is still on sale.
    await expect(
      runDriftPassForAccount(
        { ...deps(), checkpoint: (label: string) => { if (label === 'repair:mended') throw new Error('killed') } },
        { accountId },
      ),
    ).rejects.toThrow('killed')
    expect(shop.calls.filter((call) => call.op === 'update')).toEqual([])
    expect((await refRow(articleId)).productId).not.toBe(goneId)

    // The next pass finds no drift at all, and still publishes what it owes.
    const result = await runDriftPassForAccount(deps(), { accountId })

    expect(result.driftFound).toBe(0)
    expect(result.repairedAutomatically).toBe(1)
    expect(shop.calls.filter((call) => call.op === 'update')).toHaveLength(1)
    expect(shop.articles.get(remote.id)?.bodyHtml).toContain('Steel bottle 1000')
    expect(await openRepairs(db, accountScope(accountId))).toEqual([])
  })

  it('leaves a store with nothing published entirely alone', async () => {
    const result = await runDriftPassForAccount(deps(), { accountId })
    expect(result).toEqual({
      articlesChecked: 0,
      driftFound: 0,
      repairedAutomatically: 0,
      cardsRaised: 0,
      rewritesQueued: 0,
    })
  })

  // ── An operator moving one of these numbers for one store ─────────────────
  //
  // How long a product must have been unbuyable before an article recommending
  // it counts as wrong is one of the numbers an operator can move for a single
  // store without a deploy. Until this pass read those rows it took the repo
  // file's number and then stamped the piece of work it raised with the version
  // that means "the repo file judged this" — true about the version, wrong
  // about everything the operator had asked for.

  async function setOverride(forAccountId: string, key: string, value: unknown): Promise<void> {
    await db.insert(schema.rulesOverrides).values({
      accountId: forAccountId,
      locale: null,
      pageType: null,
      key,
      value,
      updatedBy: 'test-operator',
      updatedAt: NOW,
    })
  }

  /** A published article naming a product that went unbuyable five days ago. */
  async function articleNamingAProductOutOfStockFiveDays(): Promise<string> {
    const familyId = await seedFamily()
    const productId = await seedProduct({
      shopifyId: 'shopify-empty',
      title: 'Steel bottle 750',
      familyId,
      available: false,
    })
    await recordChange({
      kind: 'availability_changed',
      entityId: 'shopify-empty',
      occurredAt: '2026-09-15T09:00:00.000Z',
    })
    return seedPublishedArticle({ productId, slug: 'out-of-stock' })
  }

  it('raises a card the repo numbers would not, once the out-of-stock window is moved for that store', async () => {
    const articleId = await articleNamingAProductOutOfStockFiveDays()

    // Five days unbuyable against a floor of fourteen: nothing to say yet.
    expect((await runDriftPassForAccount(deps(), { accountId })).driftFound).toBe(0)
    expect(await opportunityFor(articleId)).toBeUndefined()

    await setOverride(accountId, 'signals.product_change_impact.out_of_stock_days_min', 3)

    expect((await runDriftPassForAccount(deps(), { accountId })).driftFound).toBe(1)
    const raised = await opportunityFor(articleId)
    expect(raised).toMatchObject({ signalType: 'product_change_impact' })
    // The record says it was judged by a moved number, not by the repo file.
    expect(raised?.rulesVersion).toMatch(
      new RegExp(`^${rules().rulesVersion}\\+ov\\.[0-9a-f]{16}$`),
    )
  })

  it('leaves a store with no row of its own judged and stamped exactly as before', async () => {
    const somebodyElse = await insertAccount(ctx.pool, 'not-this-store@example.com')
    await setOverride(somebodyElse, 'signals.product_change_impact.out_of_stock_days_min', 3)

    const articleId = await articleNamingAProductOutOfStockFiveDays()
    expect((await runDriftPassForAccount(deps(), { accountId })).driftFound).toBe(0)

    // And a card this store does earn still stamps the bare file hash it always did.
    await recordChange({
      kind: 'product_deleted',
      entityId: 'shopify-empty',
      occurredAt: '2026-09-19T00:00:00.000Z',
    })
    expect((await runDriftPassForAccount(deps(), { accountId })).driftFound).toBe(1)
    expect((await opportunityFor(articleId))?.rulesVersion).toBe(rules().rulesVersion)
  })
})
