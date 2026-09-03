import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { okSchema } from '@sortiva/core'
import {
  accountScope,
  insertArticleProductRefs,
  insertArticleStub,
  insertDomainRow,
  insertMinimalOpportunity,
  insertTopic,
  markArticleDelivered,
  saveDraftBody,
  schema,
  upsertProducts,
  upsertStorePages,
} from '@sortiva/db'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { eq } from 'drizzle-orm'
import { withAccount } from '../../auth/_lib/session'
import {
  makeConfirmPublishedUrlHandler,
  makeExportArticleHandler,
  type RouteCtx,
} from './delivery'

/**
 * The two things a merchant on export mode does: download the article, and tell
 * us where they published it.
 *
 * Both of this card's user-facing done-whens are here — a bundle built after a
 * price change carries the new price, and an address on somebody else's site is
 * refused.
 */

const available = await databaseAvailable()
const NOW = new Date('2026-09-03T09:00:00.000Z')

describe.skipIf(!available)('export delivery routes', () => {
  let harness: TestDb
  let accountId: string

  beforeAll(async () => {
    harness = await setupTestDb('web_article_delivery')
  })

  afterAll(async () => {
    await harness.close()
  })

  beforeEach(async () => {
    await truncateAll(harness.pool)
    accountId = await insertAccount(harness.pool, 'delivery-route@example.com')
    await insertDomainRow(harness.db, accountScope(accountId), 'example.com')
  })

  /** A published export article that names one product, with a price the store can change under it. */
  async function seedPublishedArticle(price: number): Promise<string> {
    const scope = accountScope(accountId)
    const opportunity = await insertMinimalOpportunity(
      harness.db,
      scope,
      {
        signalType: 'uncovered_commercial_query',
        entityType: 'query_cluster',
        entityRef: 'bottles',
        evidenceJson: [],
        recommendedAction: 'create',
        status: 'scheduled',
        reasonTemplateKey: 'gate1.admitted',
        reasonParams: {},
        limitedIntelligence: false,
        rulesVersion: 'a'.repeat(64),
      },
      NOW,
    )
    const topic = await insertTopic(
      harness.db,
      scope,
      {
        opportunityId: opportunity.id,
        title: 'Best water bottles',
        targetKeyword: 'best water bottles',
        keywordCluster: null,
        intentClass: 'buying_guide',
        familyIds: [],
        kind: 'new',
        source: 'auto',
        whyLine: 'topic.auto',
        scheduledDate: '2026-09-03',
        pinned: false,
        state: 'generating',
      },
      NOW,
    )
    const article = await insertArticleStub(
      harness.db,
      scope,
      {
        topicId: topic.id,
        title: 'Best water bottles',
        slug: 'best-water-bottles',
        targetKeyword: 'best water bottles',
        state: 'draft',
      },
      NOW,
    )
    await saveDraftBody(
      harness.db,
      scope,
      article.id,
      {
        title: 'Best water bottles',
        metaDescription: 'How to choose a water bottle.',
        body: {
          intro: 'Steel is the right default[[c1]].',
          sections: [{ heading: 'Recommended', body: 'The {{p1}} suits most people.' }],
          faq: [],
        },
      },
      NOW,
    )
    await setPrice(price)
    const [product] = await harness.db
      .select()
      .from(schema.products)
      .where(eq(schema.products.accountId, accountId))
    await insertArticleProductRefs(
      harness.db,
      scope,
      article.id,
      [
        {
          productId: product!.id,
          familyId: null,
          refType: 'recommendation',
          placeholderKey: 'p1',
          fieldsRendered: ['price'],
        },
      ],
      NOW,
    )
    await markArticleDelivered(harness.db, scope, article.id, 'export', NOW)
    return article.id
  }

  /** The store's own price for the one product, as the merchant would change it. */
  async function setPrice(price: number): Promise<void> {
    await upsertProducts(
      harness.db,
      accountScope(accountId),
      [
        {
          shopifyProductId: '900',
          title: 'Trailblazer 750',
          rawBodyHtml: null,
          productType: 'Bottle',
          tags: [],
          variants: [
            { id: '1', title: 'One size', sku: 'TB-750', price, compareAtPrice: null, available: true },
          ],
          priceRange: { min: price, max: price, currency: 'USD' },
          updatedAt: NOW,
          checksum: `checksum-${price}`,
        },
      ],
      NOW,
    )
    await upsertStorePages(
      harness.db,
      accountScope(accountId),
      [
        {
          url: 'https://example.com/products/trailblazer-750',
          pageType: 'product',
          handle: 'trailblazer-750',
          shopifyId: '900',
          title: 'Trailblazer 750',
          seoTitle: null,
          seoDescription: null,
          headings: [],
          bodyHtml: null,
          outboundInternalLinks: [],
          familyIds: [],
          checksum: 'page',
        },
      ],
      NOW,
    )
  }

  const exportHandler = () =>
    withAccount(makeExportArticleHandler({ db: harness.db, now: () => NOW }), async () => accountId)
  const confirmHandler = () =>
    withAccount(makeConfirmPublishedUrlHandler({ db: harness.db, now: () => NOW }), async () => accountId)

  const download = (articleId: string) =>
    exportHandler()(new Request('http://localhost/x'), { params: Promise.resolve({ articleId }) })

  const confirm = (articleId: string, url: unknown) =>
    confirmHandler()(
      new Request('http://localhost/x', { method: 'POST', body: JSON.stringify({ url }) }),
      { params: Promise.resolve({ articleId }) },
    )

  async function markdownOf(articleId: string): Promise<string> {
    const response = await download(articleId)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { files: { filename: string; content: string }[] }
    const file = body.files.find((f) => f.filename.endsWith('.md'))
    return file!.content
  }

  it('hands over Markdown, HTML and a metadata block', async () => {
    const articleId = await seedPublishedArticle(49.99)
    const response = await download(articleId)
    const body = (await response.json()) as { files: { filename: string }[] }
    expect(body.files.map((f) => f.filename)).toEqual([
      'sortiva-best-water-bottles.md',
      'sortiva-best-water-bottles.html',
      'sortiva-best-water-bottles.json',
    ])
  })

  /**
   * The card's own done-when: a bundle built after a price change carries the
   * new price and no unresolved placeholder. Nothing about the article changed
   * between the two downloads — only the store did.
   */
  it('carries the price the store charges at the moment of the download', async () => {
    const articleId = await seedPublishedArticle(49.99)
    expect(await markdownOf(articleId)).toContain('49.99 USD')

    await setPrice(39.5)

    const after = await markdownOf(articleId)
    expect(after).toContain('39.50 USD')
    expect(after).not.toContain('49.99')
    expect(after).not.toContain('{{p1}}')
    // And it links to the address the store's own inventory says the product is at.
    expect(after).toContain('https://example.com/products/trailblazer-750')
  })

  it('records what the merchant was handed, without reading it back next time', async () => {
    const articleId = await seedPublishedArticle(49.99)
    await markdownOf(articleId)
    const [ref] = await harness.db
      .select()
      .from(schema.articleProductRefs)
      .where(eq(schema.articleProductRefs.articleId, articleId))
    expect(ref!.resolvedValuesJson).toEqual({ price: '49.99 USD' })
    expect(ref!.resolvedAt).toEqual(NOW)
  })

  it('refuses the download when a referenced product has gone', async () => {
    const articleId = await seedPublishedArticle(49.99)
    await harness.db.delete(schema.products).where(eq(schema.products.accountId, accountId))

    const response = await download(articleId)
    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('bundle_not_buildable')
  })

  it('404s an article that is not this account\'s', async () => {
    const response = await download('00000000-0000-4000-8000-000000000000')
    expect(response.status).toBe(404)
  })

  it('accepts an address on the claimed domain and stores it', async () => {
    const articleId = await seedPublishedArticle(49.99)
    const response = await confirm(articleId, 'https://example.com/blogs/news/best-water-bottles')
    expect(response.status).toBe(200)
    expect(okSchema.parse(await response.json())).toEqual({ ok: true })

    const [row] = await harness.db
      .select()
      .from(schema.articles)
      .where(eq(schema.articles.id, articleId))
    expect(row!.publishedUrl).toBe('https://example.com/blogs/news/best-water-bottles')
  })

  /** Done-when: a URL on another domain is rejected. */
  it('refuses an address on somebody else\'s site', async () => {
    const articleId = await seedPublishedArticle(49.99)
    const response = await confirm(articleId, 'https://rival.example/blogs/news/best-water-bottles')
    expect(response.status).toBe(422)
    const body = (await response.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('url_off_domain')
    expect(body.error.message).toContain('example.com')

    const [row] = await harness.db
      .select()
      .from(schema.articles)
      .where(eq(schema.articles.id, articleId))
    expect(row!.publishedUrl).toBeNull()
  })

  it('refuses something that is not an address at all', async () => {
    const articleId = await seedPublishedArticle(49.99)
    const response = await confirm(articleId, 'best-water-bottles')
    expect(response.status).toBe(422)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('url_malformed')
  })

  it('409s on an article that has not been handed over yet', async () => {
    const articleId = await seedPublishedArticle(49.99)
    await harness.db
      .update(schema.articles)
      .set({ state: 'draft' })
      .where(eq(schema.articles.id, articleId))

    const response = await confirm(articleId, 'https://example.com/blogs/news/x')
    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('article_not_published')
  })

  it('401s without a session', async () => {
    const articleId = await seedPublishedArticle(49.99)
    const handler = withAccount(
      makeExportArticleHandler({ db: harness.db, now: () => NOW }),
      async () => null,
    )
    const response = await handler(new Request('http://localhost/x'), {
      params: Promise.resolve({ articleId }),
    })
    expect(response.status).toBe(401)
  })
})
