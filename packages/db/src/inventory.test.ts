import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { accountScope, systemScope } from './scope'
import {
  accountsWithLiveShopifyConnection,
  familyIdsByShopifyProductId,
  followOurArticleRename,
  listStorePages,
  readStorePageBody,
  listLiveStorePages,
  markStorePagesGoneNotSeenSince,
  markStorePagesOurs,
  markStorePagesSeen,
  publishedArticleAddresses,
  shopPostsWePublished,
  storePageChecksums,
  upsertStorePages,
  type StorePageInput,
} from './repositories/inventory'
import { listOpenOpportunities, upsertOpportunity } from './repositories/opportunities'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from './testing'

/**
 * A day of its own for every fixture topic.
 *
 * The calendar holds one live topic per store per day, enforced by a unique
 * index since schema wave 7. A fixture that hard-codes a single date can
 * therefore only be called once per account, which is not what these tests are
 * about — they need several articles for one store, and the day each was
 * scheduled on is incidental to all of them.
 */
let fixtureDay = 0
function nextScheduledDate(): string {
  return new Date(Date.UTC(2026, 9, 1 + fixtureDay++)).toISOString().slice(0, 10)
}


/**
 * The inventory against a real Postgres, because the two things that matter
 * about it are database behaviour: that re-reading a store converges on the same
 * rows rather than accumulating them, and that a nightly read cannot demote a
 * page we published back to an ordinary blog post.
 */

const available = await databaseAvailable()

function page(over: Partial<StorePageInput> = {}): StorePageInput {
  return {
    url: 'https://shop.example/collections/boots',
    pageType: 'collection',
    handle: 'boots',
    shopifyId: '1',
    title: 'Boots',
    seoTitle: 'Boots',
    seoDescription: 'Every boot we sell.',
    headings: ['Waterproof'],
    bodyHtml: '<p>Boots for the hills.</p>',
    outboundInternalLinks: ['https://shop.example/pages/sizing'],
    familyIds: [],
    checksum: 'checksum-1',
    ...over,
  }
}

describe.skipIf(!available)('the store content inventory', () => {
  let ctx: TestDb
  let pool: pg.Pool
  let accountId: string

  beforeAll(async () => {
    ctx = await setupTestDb('inventory')
    pool = ctx.pool
  })

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(pool)
    accountId = await insertAccount(pool, 'inventory@example.com')
  })

  it('holds one row per address however often the store is read', async () => {
    const scope = accountScope(accountId)
    await upsertStorePages(ctx.db, scope, [page()])
    await upsertStorePages(ctx.db, scope, [page({ title: 'Walking boots', checksum: 'checksum-2' })])

    const rows = await listStorePages(ctx.db, scope)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.title).toBe('Walking boots')
    expect(rows[0]?.checksum).toBe('checksum-2')
  })

  it('reads the body back as it was published', async () => {
    const scope = accountScope(accountId)
    await upsertStorePages(ctx.db, scope, [page({ bodyHtml: '<p>Boots for the hills.</p>' })])
    const [row] = await listStorePages(ctx.db, scope)
    expect(readStorePageBody(row!)).toBe('<p>Boots for the hills.</p>')
  })

  it('reports the checksums it holds, and nothing for addresses it has never seen', async () => {
    const scope = accountScope(accountId)
    await upsertStorePages(ctx.db, scope, [page()])
    const known = await storePageChecksums(ctx.db, scope, [
      'https://shop.example/collections/boots',
      'https://shop.example/pages/about',
    ])
    expect(known.get('https://shop.example/collections/boots')).toBe('checksum-1')
    expect(known.has('https://shop.example/pages/about')).toBe(false)
  })

  it('never demotes an article of ours back to an ordinary blog post', async () => {
    const scope = accountScope(accountId)
    const url = 'https://shop.example/blogs/journal/winter-boots'
    await upsertStorePages(ctx.db, scope, [
      page({ url, pageType: 'article_ours', handle: 'winter-boots', shopifyId: '77' }),
    ])
    await upsertStorePages(ctx.db, scope, [
      page({ url, pageType: 'blog_article', handle: 'winter-boots', shopifyId: '77', title: 'Edited' }),
    ])

    const rows = await listStorePages(ctx.db, scope)
    expect(rows[0]?.pageType).toBe('article_ours')
    expect(rows[0]?.title).toBe('Edited')
  })

  it('sees only its own account, even when another store has the same address', async () => {
    const other = await insertAccount(pool, 'other@example.com')
    await upsertStorePages(ctx.db, accountScope(accountId), [page()])
    await upsertStorePages(ctx.db, accountScope(other), [page({ title: 'Someone else' })])

    const rows = await listStorePages(ctx.db, accountScope(accountId))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.title).toBe('Boots')
  })

  it('finds a product family by the id the store gave the product', async () => {
    const scope = accountScope(accountId)
    const family = await pool.query(
      `insert into product_families (account_id, name, grouping_source, confidence)
       values ($1, 'Hiking boots', 'collection', 'high') returning id`,
      [accountId],
    )
    const familyId = family.rows[0].id as string
    await pool.query(
      `insert into products (account_id, shopify_product_id, title, family_id)
       values ($1, 'p1', 'Trailblazer', $2), ($1, 'p2', 'Townsman', null)`,
      [accountId, familyId],
    )

    const map = await familyIdsByShopifyProductId(ctx.db, scope, ['p1', 'p2', 'p3'])
    expect(map.get('p1')).toBe(familyId)
    expect(map.has('p2')).toBe(false)
    expect(map.has('p3')).toBe(false)
  })

  it('lists the stores whose connection is still good', async () => {
    const dead = await insertAccount(pool, 'dead@example.com')
    await pool.query(
      `insert into shopify_conns (account_id, shop_handle, access_token) values ($1, 'live-shop', 'x')`,
      [accountId],
    )
    await pool.query(
      `insert into shopify_conns (account_id, shop_handle, access_token, invalidated_at)
       values ($1, 'dead-shop', 'x', now())`,
      [dead],
    )

    const live = await accountsWithLiveShopifyConnection(
      ctx.db,
      systemScope('the nightly inventory sweep chooses which stores to work for'),
    )
    expect(live).toEqual([accountId])
  })
})

describe.skipIf(!available)('marking a page the store stopped serving', () => {
  let ctx: TestDb
  let pool: pg.Pool
  let accountId: string

  const T0 = new Date('2026-09-07T03:00:00Z')
  const T1 = new Date('2026-09-08T03:00:00Z')

  beforeAll(async () => {
    ctx = await setupTestDb('inventory_gone')
    pool = ctx.pool
  })

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(pool)
    accountId = await insertAccount(pool, 'gone@example.com')
  })

  it('marks what the walk did not see and leaves what it did', async () => {
    const scope = accountScope(accountId)
    await upsertStorePages(ctx.db, scope, [page(), page({ url: 'https://shop.example/collections/hats', shopifyId: '2' })], T0)

    await markStorePagesSeen(ctx.db, scope, ['https://shop.example/collections/boots'], T1)
    const marked = await markStorePagesGoneNotSeenSince(ctx.db, scope, T1)

    expect(marked).toBe(1)
    const byUrl = new Map((await listStorePages(ctx.db, scope)).map((r) => [r.url, r.status]))
    expect(byUrl.get('https://shop.example/collections/boots')).toBe('live')
    expect(byUrl.get('https://shop.example/collections/hats')).toBe('gone')
  })

  it('counts each absent page once, so a nightly walk does not re-mark it', async () => {
    const scope = accountScope(accountId)
    await upsertStorePages(ctx.db, scope, [page()], T0)

    expect(await markStorePagesGoneNotSeenSince(ctx.db, scope, T1)).toBe(1)
    expect(await markStorePagesGoneNotSeenSince(ctx.db, scope, T1)).toBe(0)
  })

  it('records a page as seen without disturbing its change detector', async () => {
    const scope = accountScope(accountId)
    await upsertStorePages(ctx.db, scope, [page({ checksum: 'checksum-1' })], T0)

    await markStorePagesSeen(ctx.db, scope, ['https://shop.example/collections/boots'], T1)

    const [row] = await listStorePages(ctx.db, scope)
    // The checksum is what everything downstream watches for an edit. Being
    // looked at is not an edit.
    expect(row?.checksum).toBe('checksum-1')
    expect(row?.lastSyncedAt).toEqual(T1)
  })

  it('brings a restored page back to live', async () => {
    const scope = accountScope(accountId)
    await upsertStorePages(ctx.db, scope, [page()], T0)
    await markStorePagesGoneNotSeenSince(ctx.db, scope, T1)

    await markStorePagesSeen(ctx.db, scope, ['https://shop.example/collections/boots'], T1)

    const [row] = await listStorePages(ctx.db, scope)
    expect(row?.status).toBe('live')
  })

  it('never marks one of our own published articles gone', async () => {
    const scope = accountScope(accountId)
    await upsertStorePages(ctx.db, scope, [
      page({ url: 'https://shop.example/blogs/journal/ours', shopifyId: '9', pageType: 'article_ours' }),
    ], T0)

    // An export-mode store has our articles nowhere the walk can see, so the
    // walk not finding one says nothing about whether it exists.
    expect(await markStorePagesGoneNotSeenSince(ctx.db, scope, T1)).toBe(0)
    const [row] = await listStorePages(ctx.db, scope)
    expect(row?.status).toBe('live')
  })

  it('lists only the pages the store still serves', async () => {
    const scope = accountScope(accountId)
    await upsertStorePages(ctx.db, scope, [page(), page({ url: 'https://shop.example/collections/hats', shopifyId: '2' })], T0)
    await markStorePagesSeen(ctx.db, scope, ['https://shop.example/collections/boots'], T1)
    await markStorePagesGoneNotSeenSince(ctx.db, scope, T1)

    expect((await listLiveStorePages(ctx.db, scope)).map((r) => r.url)).toEqual([
      'https://shop.example/collections/boots',
    ])
    // The deleted row is filtered, not forgotten — the walk can find the page
    // again and put it straight back.
    expect(await listStorePages(ctx.db, scope)).toHaveLength(2)
  })

  it('never reaches another account’s pages', async () => {
    const other = await insertAccount(pool, 'other@example.com')
    await upsertStorePages(ctx.db, accountScope(other), [page()], T0)
    await upsertStorePages(ctx.db, accountScope(accountId), [page()], T0)

    expect(await markStorePagesGoneNotSeenSince(ctx.db, accountScope(accountId), T1)).toBe(1)
    const [theirs] = await listStorePages(ctx.db, accountScope(other))
    expect(theirs?.status).toBe('live')
  })
})

describe.skipIf(!available)('recognising an article we published', () => {
  let ctx: TestDb
  let pool: pg.Pool
  let accountId: string

  const T0 = new Date('2026-09-07T03:00:00Z')
  const T1 = new Date('2026-09-08T03:00:00Z')

  beforeAll(async () => {
    ctx = await setupTestDb('inventory_ours')
    pool = ctx.pool
  })

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(pool)
    accountId = await insertAccount(pool, 'ours@example.com')
  })

  /**
   * One article of ours, published. Raw SQL because the chain an article hangs
   * off — a piece of work, then a calendar topic — belongs to another part of
   * the product, and none of it is what these tests are about.
   */
  async function publishedArticle(
    slug: string,
    over: {
      readonly owner?: string
      readonly url?: string | null
      readonly state?: string
      readonly publishedAt?: string
      readonly delivery?: string
    } = {},
  ): Promise<string> {
    const owner = over.owner ?? accountId
    const opportunity = await pool.query<{ id: string }>(
      `INSERT INTO opportunities
         (account_id, signal_type, entity_type, entity_ref, evidence_json, impact,
          impact_score, confidence, reason_template_key, recommended_action, rules_version)
       VALUES ($1,'uncovered_commercial_query','query_cluster',$2,'[]'::jsonb,'high',
          80, 70, 'uncovered_commercial_query.default', 'create', 'test')
       RETURNING id`,
      [owner, `cluster:${slug}`],
    )
    const topic = await pool.query<{ id: string }>(
      `INSERT INTO topics (account_id, opportunity_id, title, intent_class, source, scheduled_date)
       VALUES ($1,$2,$3,'buying_guide','auto',$4) RETURNING id`,
      [owner, opportunity.rows[0]!.id, slug, nextScheduledDate()],
    )
    const article = await pool.query<{ id: string }>(
      `INSERT INTO articles (account_id, topic_id, title, slug, state, published_url, published_at, delivery)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [
        owner,
        topic.rows[0]!.id,
        slug,
        slug,
        over.state ?? 'published',
        over.url === undefined ? `https://shop.example/blogs/news/${slug}` : over.url,
        over.publishedAt ?? '2026-03-01T00:00:00Z',
        over.delivery ?? 'export',
      ],
    )
    return article.rows[0]!.id
  }

  /** The claim a publication went out under, once the shop had answered. */
  async function confirmedClaim(
    articleId: string,
    shopifyArticleId: string,
    over: { readonly owner?: string; readonly revision?: number } = {},
  ): Promise<void> {
    const suffix = over.revision ? `#r${over.revision}` : ''
    await pool.query(
      `INSERT INTO publish_intents (article_external_id, account_id, state, shopify_article_id)
       VALUES ($1,$2,'confirmed',$3)`,
      [`sortiva-${articleId}${suffix}`, over.owner ?? accountId, shopifyArticleId],
    )
  }

  it('marks a page as ours and names the article behind it, without disturbing its change detector', async () => {
    const scope = accountScope(accountId)
    const articleId = await publishedArticle('best-trail-shoes')
    const url = 'https://shop.example/blogs/news/best-trail-shoes'
    await upsertStorePages(ctx.db, scope, [page({ url, shopifyId: '61', pageType: 'blog_article' })], T0)

    expect(await markStorePagesOurs(ctx.db, scope, [{ url, articleId }])).toBe(1)

    const [row] = await listStorePages(ctx.db, scope)
    expect(row?.pageType).toBe('article_ours')
    expect(row?.articleId).toBe(articleId)
    // Recognising a page is not editing it. The checksum is what everything
    // downstream watches for an edit, and paid analyses hang off one.
    expect(row?.checksum).toBe('checksum-1')
    expect(row?.lastSyncedAt).toEqual(T0)
  })

  it('marks several pages at once, each against its own article', async () => {
    const scope = accountScope(accountId)
    const first = await publishedArticle('first')
    const second = await publishedArticle('second')
    const urlA = 'https://shop.example/blogs/news/first'
    const urlB = 'https://shop.example/blogs/news/second'
    await upsertStorePages(
      ctx.db,
      scope,
      [
        page({ url: urlA, shopifyId: '61', pageType: 'blog_article' }),
        page({ url: urlB, shopifyId: '62', pageType: 'blog_article' }),
      ],
      T0,
    )

    await markStorePagesOurs(ctx.db, scope, [
      { url: urlA, articleId: first },
      { url: urlB, articleId: second },
    ])

    const byUrl = new Map((await listStorePages(ctx.db, scope)).map((r) => [r.url, r.articleId]))
    expect(byUrl.get(urlA)).toBe(first)
    expect(byUrl.get(urlB)).toBe(second)
  })

  it('never reaches another account’s page at the same address', async () => {
    const other = await insertAccount(pool, 'ours-other@example.com')
    const url = 'https://shop.example/blogs/news/best-trail-shoes'
    const articleId = await publishedArticle('best-trail-shoes')
    await upsertStorePages(ctx.db, accountScope(other), [page({ url, pageType: 'blog_article' })], T0)
    await upsertStorePages(ctx.db, accountScope(accountId), [page({ url, pageType: 'blog_article' })], T0)

    await markStorePagesOurs(ctx.db, accountScope(accountId), [{ url, articleId }])

    const [theirs] = await listStorePages(ctx.db, accountScope(other))
    expect(theirs?.pageType).toBe('blog_article')
    expect(theirs?.articleId).toBeNull()
  })

  it('keeps the marking when the nightly read finds the post edited', async () => {
    const scope = accountScope(accountId)
    const articleId = await publishedArticle('best-trail-shoes')
    const url = 'https://shop.example/blogs/news/best-trail-shoes'
    await upsertStorePages(ctx.db, scope, [page({ url, pageType: 'blog_article' })], T0)
    await markStorePagesOurs(ctx.db, scope, [{ url, articleId }])

    // The store hands our article back as an ordinary blog post. A nightly read
    // that demoted it would lose the only thing recording whose it is.
    await upsertStorePages(
      ctx.db,
      scope,
      [page({ url, pageType: 'blog_article', checksum: 'checksum-2' })],
      T1,
    )

    const [row] = await listStorePages(ctx.db, scope)
    expect(row?.pageType).toBe('article_ours')
    expect(row?.articleId).toBe(articleId)
  })

  it('never marks a page we recognised as ours gone', async () => {
    const scope = accountScope(accountId)
    const articleId = await publishedArticle('best-trail-shoes')
    const url = 'https://shop.example/blogs/news/best-trail-shoes'
    await upsertStorePages(ctx.db, scope, [page({ url, pageType: 'blog_article' })], T0)
    await markStorePagesOurs(ctx.db, scope, [{ url, articleId }])

    // The store on export delivery has our articles nowhere this walk can look,
    // so a walk not finding one is evidence of nothing at all. The marking is
    // what tells the sweep to leave it alone, and this is the marking the walk
    // itself writes rather than one a test planted.
    expect(await markStorePagesGoneNotSeenSince(ctx.db, scope, T1)).toBe(0)
    const [row] = await listStorePages(ctx.db, scope)
    expect(row?.status).toBe('live')
  })

  it('hands the walk every article we published, oldest first, and nothing else', async () => {
    const scope = accountScope(accountId)
    const older = await publishedArticle('older', { publishedAt: '2026-01-01T00:00:00Z' })
    const newer = await publishedArticle('newer', { publishedAt: '2026-06-01T00:00:00Z' })
    // A draft has no address to compare against, and an article that reached
    // nobody has not been published anywhere for the walk to find.
    await publishedArticle('unwritten', { state: 'draft', url: null })
    await publishedArticle('undelivered', { url: null })

    expect(await publishedArticleAddresses(ctx.db, scope)).toEqual([
      { articleId: older, url: 'https://shop.example/blogs/news/older' },
      { articleId: newer, url: 'https://shop.example/blogs/news/newer' },
    ])
  })

  it('never hands the walk another account’s articles', async () => {
    const other = await insertAccount(pool, 'ours-articles-other@example.com')
    await publishedArticle('theirs', { owner: other })

    expect(await publishedArticleAddresses(ctx.db, accountScope(accountId))).toEqual([])
  })

  describe('following one of our posts to a new address on the shop', () => {
    const BEFORE = 'https://shop.example/blogs/news/best-trail-shoes'
    const AFTER = 'https://shop.example/blogs/news/best-walking-shoes'

    /** An article we posted to the shop ourselves, recognised at `BEFORE`. */
    async function autoPublished(): Promise<string> {
      const scope = accountScope(accountId)
      const articleId = await publishedArticle('best-trail-shoes', { delivery: 'auto' })
      await confirmedClaim(articleId, '61')
      await upsertStorePages(
        ctx.db,
        scope,
        [page({ url: BEFORE, shopifyId: '61', pageType: 'blog_article' })],
        T0,
      )
      await markStorePagesOurs(ctx.db, scope, [{ url: BEFORE, articleId }])
      return articleId
    }

    it('hands the walk each post on the shop with the claim it went out under', async () => {
      const articleId = await publishedArticle('best-trail-shoes', { delivery: 'auto' })
      await confirmedClaim(articleId, '61')

      expect(await shopPostsWePublished(ctx.db, accountScope(accountId))).toEqual([
        { articleExternalId: `sortiva-${articleId}`, shopifyArticleId: '61' },
      ])
    })

    it('leaves out a claim the shop never answered, and another account’s posts', async () => {
      const scope = accountScope(accountId)
      const articleId = await publishedArticle('best-trail-shoes', { delivery: 'auto' })
      // Made and never confirmed: a post we cannot prove exists, and the id
      // column is empty until the shop has answered.
      await pool.query(
        `INSERT INTO publish_intents (article_external_id, account_id, state) VALUES ($1,$2,'pending')`,
        [`sortiva-${articleId}`, accountId],
      )
      const other = await insertAccount(pool, 'renames-other@example.com')
      const theirs = await publishedArticle('theirs', { owner: other, delivery: 'auto' })
      await confirmedClaim(theirs, '99', { owner: other })

      expect(await shopPostsWePublished(ctx.db, scope)).toEqual([])
    })

    it('writes the new address and retires the row the shop has abandoned', async () => {
      const scope = accountScope(accountId)
      const articleId = await autoPublished()

      expect(
        await followOurArticleRename(ctx.db, scope, { articleId, from: BEFORE, to: AFTER }),
      ).toBe(true)

      expect(await publishedArticleAddresses(ctx.db, scope)).toEqual([{ articleId, url: AFTER }])
      const [row] = await listStorePages(ctx.db, scope)
      expect(row?.status).toBe('gone')
      // Still our record of what we delivered and where. The shop moving the
      // page is not evidence that we did not publish it.
      expect(row?.pageType).toBe('article_ours')
      expect(row?.articleId).toBe(articleId)
      expect(await listLiveStorePages(ctx.db, scope)).toEqual([])
    })

    it('never overwrites an address an export merchant typed in themselves', async () => {
      const scope = accountScope(accountId)
      const articleId = await publishedArticle('best-trail-shoes', { delivery: 'export' })
      await upsertStorePages(
        ctx.db,
        scope,
        [page({ url: BEFORE, shopifyId: '61', pageType: 'blog_article' })],
        T0,
      )
      await markStorePagesOurs(ctx.db, scope, [{ url: BEFORE, articleId }])

      expect(
        await followOurArticleRename(ctx.db, scope, { articleId, from: BEFORE, to: AFTER }),
      ).toBe(false)

      expect(await publishedArticleAddresses(ctx.db, scope)).toEqual([{ articleId, url: BEFORE }])
      const [row] = await listStorePages(ctx.db, scope)
      expect(row?.status).toBe('live')
    })

    it('does nothing when the address we hold is not the one being moved from', async () => {
      const scope = accountScope(accountId)
      const articleId = await autoPublished()

      // Two walks racing, or a second message about a rename we already
      // followed. Moving from an address we no longer hold would retire a row
      // the shop is serving.
      expect(
        await followOurArticleRename(ctx.db, scope, {
          articleId,
          from: 'https://shop.example/blogs/news/something-else',
          to: AFTER,
        }),
      ).toBe(false)

      expect(await publishedArticleAddresses(ctx.db, scope)).toEqual([{ articleId, url: BEFORE }])
      const [row] = await listStorePages(ctx.db, scope)
      expect(row?.status).toBe('live')
    })

    /** Only the suggestions keyed on an address; the article fixture leaves one keyed on a search. */
    async function openPageSuggestions(scope: ReturnType<typeof accountScope>) {
      return (await listOpenOpportunities(ctx.db, scope)).filter((row) => row.entityType === 'url')
    }

    /**
     * A suggestion about one page, sitting in the merchant's list unanswered.
     * `freshness_opportunity` is the kind that names one of our own posts, which
     * is the only kind a rename can be about.
     */
    async function suggestionAbout(
      url: string,
      over: { readonly status?: 'new' | 'accepted' | 'blocked' | 'scheduled'; readonly signalType?: 'freshness_opportunity' | 'missing_or_weak_metadata' } = {},
    ): Promise<string> {
      const { row } = await upsertOpportunity(ctx.db, accountScope(accountId), {
        accountId,
        signalType: over.signalType ?? 'freshness_opportunity',
        entityType: 'url',
        entityRef: url,
        evidence: [
          { key: 'page', value: url, source: 'content_inventory', fetchedAt: '2026-09-01T00:00:00.000Z' },
        ],
        confidence: 60,
        confidenceBand: 'medium',
        reasonTemplateKey: 'freshness_opportunity.refresh',
        reasonParams: {},
        recommendedAction: 'REFRESH',
        preconditions: [],
        status: over.status ?? 'new',
        rulesVersion: 'test-rules-version',
        limitedIntelligence: false,
        detectedAt: '2026-09-01T00:00:00.000Z',
        rawScore: 5,
        tasks: [],
        impactScore: 70,
        impact: 'high',
      })
      return row.id
    }

    it('carries the open suggestion about the post over to the new address', async () => {
      const scope = accountScope(accountId)
      const articleId = await autoPublished()
      const suggestionId = await suggestionAbout(BEFORE)

      expect(
        await followOurArticleRename(ctx.db, scope, { articleId, from: BEFORE, to: AFTER }),
      ).toBe(true)

      // Without this the address is marked gone with a live card pointing at
      // it, and the next nightly walk takes the card down as though the
      // merchant had deleted the page. They renamed it and never answered it.
      expect(
        (await openPageSuggestions(scope)).map((row) => ({
          id: row.id,
          entityRef: row.entityRef,
          status: row.status,
        })),
      ).toEqual([{ id: suggestionId, entityRef: AFTER, status: 'new' }])
    })

    it('leaves a suggestion where it is when one of the same kind is already open at the new address', async () => {
      const scope = accountScope(accountId)
      const articleId = await autoPublished()
      const stale = await suggestionAbout(BEFORE)
      const current = await suggestionAbout(AFTER)

      expect(
        await followOurArticleRename(ctx.db, scope, { articleId, from: BEFORE, to: AFTER }),
      ).toBe(true)

      // Only one open suggestion of a kind may exist per subject, and the one
      // already at the new address was written against the page as it now is.
      // The stranded row is the walk's to take down.
      expect(new Map((await openPageSuggestions(scope)).map((row) => [row.id, row.entityRef]))).toEqual(
        new Map([
          [stale, BEFORE],
          [current, AFTER],
        ]),
      )
    })

    it('does not move a suggestion the calendar has taken over', async () => {
      const scope = accountScope(accountId)
      const articleId = await autoPublished()
      const scheduled = await suggestionAbout(BEFORE, { status: 'scheduled' })

      expect(
        await followOurArticleRename(ctx.db, scope, { articleId, from: BEFORE, to: AFTER }),
      ).toBe(true)

      expect(
        (await openPageSuggestions(scope)).map((row) => ({ id: row.id, entityRef: row.entityRef })),
      ).toEqual([{ id: scheduled, entityRef: BEFORE }])
    })

    it('moves nothing when the rename itself is refused', async () => {
      const scope = accountScope(accountId)
      const articleId = await publishedArticle('best-trail-shoes', { delivery: 'export' })
      await upsertStorePages(
        ctx.db,
        scope,
        [page({ url: BEFORE, shopifyId: '61', pageType: 'blog_article' })],
        T0,
      )
      await markStorePagesOurs(ctx.db, scope, [{ url: BEFORE, articleId }])
      const suggestionId = await suggestionAbout(BEFORE)

      expect(
        await followOurArticleRename(ctx.db, scope, { articleId, from: BEFORE, to: AFTER }),
      ).toBe(false)

      expect(
        (await openPageSuggestions(scope)).map((row) => ({ id: row.id, entityRef: row.entityRef })),
      ).toEqual([{ id: suggestionId, entityRef: BEFORE }])
    })

    it('never reaches another account’s article or page', async () => {
      const other = await insertAccount(pool, 'rename-scope-other@example.com')
      const articleId = await publishedArticle('best-trail-shoes', {
        owner: other,
        delivery: 'auto',
      })
      await upsertStorePages(
        ctx.db,
        accountScope(other),
        [page({ url: BEFORE, shopifyId: '61', pageType: 'blog_article' })],
        T0,
      )

      expect(
        await followOurArticleRename(ctx.db, accountScope(accountId), {
          articleId,
          from: BEFORE,
          to: AFTER,
        }),
      ).toBe(false)

      expect(await publishedArticleAddresses(ctx.db, accountScope(other))).toEqual([
        { articleId, url: BEFORE },
      ])
      const [theirs] = await listStorePages(ctx.db, accountScope(other))
      expect(theirs?.status).toBe('live')
    })
  })
})
