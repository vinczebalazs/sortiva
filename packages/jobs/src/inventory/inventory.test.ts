import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { accountScope, listStorePages, readStorePageBody } from '@sortiva/db'
import { optimizeRouteFor } from '@sortiva/core'
import { DbOpportunitySource } from '../scan/opportunity-source'
import { requestArticleRefresh } from '../generation/request-refresh'
import {
  databaseAvailable,
  insertAccount,
  setupTestDb,
  truncateAll,
  type TestDb,
} from '@sortiva/db/testing'
import { silentLogger } from '@sortiva/core'
import { runInventorySync } from './tasks'
import type { InventoryConnectionStore, InventoryTaskDeps, ShopifyAdminReader } from './deps'

/**
 * The inventory end to end, against a real database and a stand-in store.
 *
 * There is no Partner account and no dev store, so the store is a fixture: a
 * shop with two hand-picked collections, one rule-based one, three products,
 * two static pages and two blogs whose posts are spread across them. It answers
 * exactly the shapes Shopify's admin interface answers, including the awkward
 * ones — the two separate collection lists, and the search title and description
 * arriving as a separate request per page.
 *
 * What is being proved is the thing the card asks for: that a whole store ends
 * up in the inventory with the right kind recorded against every address, and
 * that editing a page's words is what makes its row move.
 */

const available = await databaseAvailable()

interface FixtureThing {
  id: string
  handle: string
  title: string
  body_html: string | null
  seoTitle?: string
  seoDescription?: string
  memberIds?: string[]
}

interface FixtureStore {
  domain: string
  customCollections: FixtureThing[]
  smartCollections: FixtureThing[]
  products: FixtureThing[]
  pages: FixtureThing[]
  blogs: { id: string; handle: string; articles: FixtureThing[] }[]
}

function fixtureStore(): FixtureStore {
  return {
    domain: 'shop.example',
    customCollections: [
      {
        id: '11',
        handle: 'walking-boots',
        title: 'Walking boots',
        body_html: '<h2>Fit</h2><p>See our <a href="/pages/sizing">sizing guide</a>.</p>',
        seoTitle: 'Walking boots for the hills',
        seoDescription: 'Boots that keep the weather out.',
        memberIds: ['31', '32'],
      },
      {
        id: '12',
        handle: 'waterproofs',
        title: 'Waterproofs',
        body_html: '<p>Jackets and overtrousers.</p>',
        memberIds: ['33'],
      },
    ],
    smartCollections: [
      {
        id: '21',
        handle: 'under-100',
        title: 'Under £100',
        body_html: '<p>Everything below a hundred pounds.</p>',
        memberIds: ['32'],
      },
    ],
    products: [
      { id: '31', handle: 'fell-boot', title: 'Fell boot', body_html: '<p>A stiff boot.</p>' },
      { id: '32', handle: 'moor-boot', title: 'Moor boot', body_html: '<p>A softer boot.</p>' },
      { id: '33', handle: 'rain-shell', title: 'Rain shell', body_html: '<p>A light shell.</p>' },
    ],
    pages: [
      { id: '41', handle: 'sizing', title: 'Sizing guide', body_html: '<h2>Widths</h2>' },
      { id: '42', handle: 'about', title: 'About us', body_html: '<p>Since 1994.</p>' },
    ],
    blogs: [
      {
        id: '51',
        handle: 'news',
        articles: [
          { id: '61', handle: 'spring-range', title: 'The spring range', body_html: '<p>New.</p>' },
        ],
      },
      {
        id: '52',
        handle: 'guides',
        articles: [
          { id: '71', handle: 'boot-care', title: 'Caring for boots', body_html: '<p>Dry them.</p>' },
          { id: '72', handle: 'first-hike', title: 'Your first hike', body_html: '<p>Start small.</p>' },
        ],
      },
    ],
  }
}

/**
 * A stand-in for Shopify's admin interface, counting what was asked of it.
 *
 * The count matters as much as the answers: a walk that re-read the whole store
 * every night, or that asked for the same page twice in one run, would still
 * produce a correct inventory and would still be wrong.
 */
class FakeAdmin implements ShopifyAdminReader {
  readonly paths: string[] = []

  constructor(private readonly store: FixtureStore) {}

  async get<T>(_auth: { shop: string; accessToken: string }, path: string): Promise<T> {
    this.paths.push(path)
    return this.route(path) as T
  }

  private route(path: string): unknown {
    const [route, query = ''] = path.split('?')
    const params = new URLSearchParams(query)
    const limit = Number(params.get('limit') ?? '50')
    const sinceId = params.get('since_id') ?? undefined
    const segments = (route ?? '').replace(/\.json$/, '').split('/')

    if (segments[0] === 'shop') return { shop: { domain: this.store.domain } }
    if (segments[0] === 'blogs' && segments.length === 1) {
      return { blogs: this.store.blogs.map((blog) => ({ id: blog.id, handle: blog.handle })) }
    }
    if (segments[0] === 'blogs' && segments[2] === 'articles') {
      const blog = this.store.blogs.find((candidate) => candidate.id === segments[1])
      return { articles: window(blog?.articles ?? [], limit, sinceId) }
    }
    if (segments[0] === 'custom_collections') {
      return { custom_collections: window(this.store.customCollections, limit, sinceId) }
    }
    if (segments[0] === 'smart_collections') {
      return { smart_collections: window(this.store.smartCollections, limit, sinceId) }
    }
    if (segments[0] === 'products' && segments.length === 1) {
      return { products: window(this.store.products, limit, sinceId) }
    }
    if (segments[0] === 'pages' && segments.length === 1) {
      return { pages: window(this.store.pages, limit, sinceId) }
    }
    if (segments.at(-1) === 'metafields') return { metafields: this.metafields(segments) }
    if (segments[0] === 'collections' && segments[2] === 'products') {
      const collection = this.collection(segments[1])
      return { products: (collection?.memberIds ?? []).map((id) => ({ id })) }
    }

    // A single thing, by id — how a webhook-driven re-read asks.
    const single = this.single(segments[0] ?? '', segments[1] ?? '')
    if (single) return single
    throw new Error(`Shopify answered 404 for ${path}.`)
  }

  private single(kind: string, id: string): Record<string, unknown> | undefined {
    if (kind === 'collections') {
      const found = this.collection(id)
      return found ? { collection: found } : undefined
    }
    if (kind === 'products') {
      const found = this.store.products.find((candidate) => candidate.id === id)
      return found ? { product: found } : undefined
    }
    if (kind === 'pages') {
      const found = this.store.pages.find((candidate) => candidate.id === id)
      return found ? { page: found } : undefined
    }
    if (kind === 'articles') {
      for (const blog of this.store.blogs) {
        const found = blog.articles.find((candidate) => candidate.id === id)
        if (found) return { article: { ...found, blog_id: blog.id } }
      }
    }
    return undefined
  }

  private collection(id: string | undefined): FixtureThing | undefined {
    return [...this.store.customCollections, ...this.store.smartCollections].find(
      (candidate) => candidate.id === id,
    )
  }

  private metafields(segments: string[]): { namespace: string; key: string; value: string }[] {
    const owner = this.single(segments[0] ?? '', segments[1] ?? '')
    const thing = owner ? (Object.values(owner)[0] as FixtureThing | undefined) : undefined
    const out: { namespace: string; key: string; value: string }[] = []
    if (thing?.seoTitle) out.push({ namespace: 'global', key: 'title_tag', value: thing.seoTitle })
    if (thing?.seoDescription) {
      out.push({ namespace: 'global', key: 'description_tag', value: thing.seoDescription })
    }
    return out
  }
}

/** Shopify's "everything after this id", which is how the walk resumes. */
function window(all: readonly FixtureThing[], limit: number, sinceId: string | undefined) {
  const from = sinceId ? all.findIndex((thing) => thing.id === sinceId) + 1 : 0
  return all.slice(from, from + limit)
}

const connected: InventoryConnectionStore = {
  async read() {
    return { shopHandle: 'demo' }
  },
  async readToken() {
    return 'shpat_token'
  },
  async markInvalid() {
    return undefined
  },
}

describe.skipIf(!available)('a whole store into the inventory', () => {
  let ctx: TestDb
  let pool: pg.Pool
  let accountId: string
  let store: FixtureStore
  let admin: FakeAdmin
  let deps: InventoryTaskDeps

  beforeAll(async () => {
    ctx = await setupTestDb('jobs-inventory')
    pool = ctx.pool
  })

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(pool)
    accountId = await insertAccount(pool, 'inventory-job@example.com')
    store = fixtureStore()
    admin = new FakeAdmin(store)
    deps = {
      getDb: () => ctx.db,
      getPool: () => pool,
      admin,
      connections: connected,
      logger: silentLogger,
    }
  })

  /** Drives the walk to its end, the way the queue does, and says how many runs it took. */
  async function walkWholeStore(): Promise<{ runs: number; changed: number }> {
    let cursor: Readonly<Record<string, string>> | undefined
    let runs = 0
    let changed = 0
    for (;;) {
      const outcome = await runInventorySync(deps, { accountId, ...(cursor ? { cursor } : {}) })
      runs += 1
      if (outcome.status === 'disconnected') throw new Error('the fixture store is connected')
      changed += outcome.result.changed
      if (outcome.status === 'done') return { runs, changed }
      cursor = outcome.cursor
      if (runs > 20) throw new Error('the walk never finished')
    }
  }

  it('lists every collection, product, page and blog post, each under the right kind', async () => {
    await walkWholeStore()

    const rows = await listStorePages(ctx.db, accountScope(accountId))
    const byUrl = new Map(rows.map((row) => [row.url, row.pageType]))

    expect(Object.fromEntries([...byUrl].sort())).toEqual({
      'https://shop.example/blogs/guides/boot-care': 'blog_article',
      'https://shop.example/blogs/guides/first-hike': 'blog_article',
      'https://shop.example/blogs/news/spring-range': 'blog_article',
      'https://shop.example/collections/under-100': 'collection',
      'https://shop.example/collections/walking-boots': 'collection',
      'https://shop.example/collections/waterproofs': 'collection',
      'https://shop.example/pages/about': 'page',
      'https://shop.example/pages/sizing': 'page',
      'https://shop.example/products/fell-boot': 'product',
      'https://shop.example/products/moor-boot': 'product',
      'https://shop.example/products/rain-shell': 'product',
    })
  })

  it('keeps the search fields, the headings and the links to the store’s own pages', async () => {
    await walkWholeStore()

    const rows = await listStorePages(ctx.db, accountScope(accountId))
    const boots = rows.find((row) => row.url.endsWith('/collections/walking-boots'))

    expect(boots?.seoTitle).toBe('Walking boots for the hills')
    expect(boots?.seoDescription).toBe('Boots that keep the weather out.')
    expect(boots?.headingsJson).toEqual(['Fit'])
    expect(boots?.outboundInternalLinks).toEqual(['https://shop.example/pages/sizing'])
    expect(readStorePageBody(boots!)).toContain('sizing guide')
  })

  it('writes nothing on the second night, and writes again once a body is edited', async () => {
    const first = await walkWholeStore()
    expect(first.changed).toBe(11)

    const second = await walkWholeStore()
    expect(second.changed).toBe(0)

    const before = await listStorePages(ctx.db, accountScope(accountId))
    const checksumBefore = before.find((row) => row.url.endsWith('/pages/about'))?.checksum

    store.pages[1]!.body_html = '<p>Since 1994. Still here.</p>'
    const third = await walkWholeStore()

    expect(third.changed).toBe(1)
    const after = await listStorePages(ctx.db, accountScope(accountId))
    const about = after.find((row) => row.url.endsWith('/pages/about'))
    expect(about?.checksum).not.toBe(checksumBefore)
    expect(readStorePageBody(about!)).toBe('<p>Since 1994. Still here.</p>')
    expect(after).toHaveLength(11)
  })

  it('re-reads only the page the store said changed', async () => {
    await walkWholeStore()
    admin.paths.length = 0

    store.customCollections[1]!.body_html = '<p>Jackets, overtrousers and gaiters.</p>'
    const outcome = await runInventorySync(deps, {
      accountId,
      targets: [{ kind: 'collection', shopifyId: '12' }],
    })

    expect(outcome.status).toBe('done')
    expect(outcome.status === 'done' && outcome.result.changedUrls).toEqual([
      'https://shop.example/collections/waterproofs',
    ])
    expect(admin.paths.some((path) => path.startsWith('products.json'))).toBe(false)
    expect(await listStorePages(ctx.db, accountScope(accountId))).toHaveLength(11)
  })

  it('shrugs off a page the merchant deleted between the webhook and our reading it', async () => {
    await walkWholeStore()

    const outcome = await runInventorySync(deps, {
      accountId,
      targets: [{ kind: 'page', shopifyId: 'never-existed' }],
    })

    expect(outcome.status).toBe('done')
    expect(outcome.status === 'done' && outcome.result.changed).toBe(0)
  })

  /**
   * The one article on this fixture shop that we published for the merchant,
   * inserted the long way round because an article only exists at the end of a
   * chain — a piece of work, then a calendar day, then the article itself.
   */
  async function ourPublishedArticle(
    url: string,
    over: { readonly delivery?: string } = {},
  ): Promise<string> {
    const opportunity = await pool.query<{ id: string }>(
      `INSERT INTO opportunities
         (account_id, signal_type, entity_type, entity_ref, evidence_json, impact,
          impact_score, confidence, reason_template_key, recommended_action, rules_version)
       VALUES ($1,'uncovered_commercial_query','query_cluster','cluster:boot-care','[]'::jsonb,
         'high', 80, 70, 'uncovered_commercial_query.default', 'create', 'test')
       RETURNING id`,
      [accountId],
    )
    const topic = await pool.query<{ id: string }>(
      `INSERT INTO topics (account_id, opportunity_id, title, intent_class, source, scheduled_date)
       VALUES ($1,$2,'Caring for boots','buying_guide','auto','2026-08-01') RETURNING id`,
      [accountId, opportunity.rows[0]!.id],
    )
    const article = await pool.query<{ id: string }>(
      `INSERT INTO articles
         (account_id, topic_id, title, slug, state, published_url, published_at, delivery)
       VALUES ($1,$2,'Caring for boots','boot-care','published',$3,'2026-08-01T09:00:00Z',$4)
       RETURNING id`,
      [accountId, topic.rows[0]!.id, url, over.delivery ?? 'export'],
    )
    return article.rows[0]!.id
  }

  /**
   * The same article, posted to this shop by us rather than downloaded — which
   * means the shop gave us an id for the post and we kept it on the claim.
   */
  async function ourPostOnTheShop(url: string, shopifyArticleId: string): Promise<string> {
    const articleId = await ourPublishedArticle(url, { delivery: 'auto' })
    await pool.query(
      `INSERT INTO publish_intents (article_external_id, account_id, state, shopify_article_id)
       VALUES ($1,$2,'confirmed',$3)`,
      [`sortiva-${articleId}`, accountId, shopifyArticleId],
    )
    return articleId
  }

  /** What the shop's `articles/update` message makes the walk go and do. */
  async function receiveArticleUpdate(shopifyArticleId: string): Promise<void> {
    const outcome = await runInventorySync(deps, {
      accountId,
      targets: [{ kind: 'blog_article', shopifyId: shopifyArticleId }],
    })
    if (outcome.status === 'disconnected') throw new Error('the fixture store is connected')
  }

  /**
   * The two behaviours this whole card exists to make reachable, driven against
   * a page **the walk itself recognised** rather than one planted by a test.
   *
   * That distinction is the point. Both behaviours were finished, merged and
   * green, and neither could ever have happened on a real shop, because nothing
   * wrote the marking they read — and every test of them planted it by hand,
   * which is exactly why nobody noticed.
   */
  it('recognises the article we published, refuses to hand the merchant edits for it, and queues it to be rewritten', async () => {
    const OURS = 'https://shop.example/blogs/guides/boot-care'
    const articleId = await ourPublishedArticle(OURS)

    await walkWholeStore()

    // The read both refusal sites make, on the row the walk left behind.
    const rows = await listStorePages(ctx.db, accountScope(accountId))
    const ours = rows.find((row) => row.url === OURS)
    expect(ours?.pageType).toBe('article_ours')
    expect(ours?.articleId).toBe(articleId)

    // The merchant's own posts on the same blog are untouched by this. If the
    // walk marked by shape rather than by our record of what we published, this
    // is where it would show.
    const theirs = rows.filter((row) => row.url !== OURS && row.url.includes('/blogs/'))
    expect(theirs.map((row) => row.pageType)).toEqual(['blog_article', 'blog_article'])

    // What the improve-this-page press does with that row: no list of edits.
    expect(optimizeRouteFor(ours!.pageType)).toBe('refresh_pool')

    // And where it goes instead — the pool of rewrites waiting for a calendar
    // day, named by the article the walk linked the page to.
    const admitted = await requestArticleRefresh(
      { db: ctx.db, now: () => new Date('2026-09-07T09:00:00Z'), logger: silentLogger },
      { accountId, articleId: ours!.articleId!, source: 'optimize_on_our_own_article' },
    )
    expect(admitted).toMatchObject({ ok: true, created: true })

    const waiting = await new DbOpportunitySource(ctx.db).acceptedContentOpportunities(accountId)
    expect(waiting).toHaveLength(1)
    expect(waiting[0]).toMatchObject({ recommendedAction: 'REFRESH' })
  })

  it('keeps recognising it on a night when nothing about it changed', async () => {
    const OURS = 'https://shop.example/blogs/guides/boot-care'
    const articleId = await ourPublishedArticle(OURS)

    await walkWholeStore()
    const second = await walkWholeStore()

    // The second walk writes no page at all — nothing on this shop moved — and
    // the marking is still there. Were recognition part of the page write, it
    // would have happened once and then quietly stopped.
    expect(second.changed).toBe(0)
    const again = (await listStorePages(ctx.db, accountScope(accountId))).find((r) => r.url === OURS)
    expect(again?.pageType).toBe('article_ours')
    expect(again?.articleId).toBe(articleId)
  })

  it('never marks the article we published gone, even after the merchant deletes it from the shop', async () => {
    const OURS = 'https://shop.example/blogs/guides/boot-care'
    await ourPublishedArticle(OURS)
    await walkWholeStore()

    // The post leaves the shop. For an export-delivery store our articles live
    // somewhere this walk cannot look at all, so a walk not finding one is
    // evidence of nothing — and this row is our record of what we delivered.
    store.blogs[1]!.articles = store.blogs[1]!.articles.filter((a) => a.handle !== 'boot-care')
    await walkWholeStore()

    const rows = await listStorePages(ctx.db, accountScope(accountId))
    expect(rows.find((row) => row.url === OURS)?.status).toBe('live')
  })

  it('recognises an article whose address the merchant only told us about later', async () => {
    const OURS = 'https://shop.example/blogs/guides/boot-care'

    // Export delivery: they download the article, publish it themselves, and
    // confirm the address days after the walk has filed the post as their own.
    await walkWholeStore()
    expect(
      (await listStorePages(ctx.db, accountScope(accountId))).find((r) => r.url === OURS)?.pageType,
    ).toBe('blog_article')

    const articleId = await ourPublishedArticle(OURS)
    await walkWholeStore()

    const row = (await listStorePages(ctx.db, accountScope(accountId))).find((r) => r.url === OURS)
    expect(row?.pageType).toBe('article_ours')
    expect(row?.articleId).toBe(articleId)
  })

  /**
   * The whole point of the rename card, driven the way the shop drives it:
   * the merchant edits the post's handle, Shopify says so, and the walk goes
   * and re-reads that one post.
   */
  describe('when the merchant renames a post we published to their shop', () => {
    const OURS = 'https://shop.example/blogs/guides/boot-care'
    const MOVED = 'https://shop.example/blogs/guides/looking-after-boots'

    /** The merchant's edit, on the shop. Only the handle moves. */
    function renameOnTheShop(): void {
      store.blogs[1]!.articles[0]!.handle = 'looking-after-boots'
    }

    async function rowsByUrl() {
      return new Map((await listStorePages(ctx.db, accountScope(accountId))).map((r) => [r.url, r]))
    }

    async function addressOf(articleId: string): Promise<string | null> {
      const { rows } = await pool.query<{ published_url: string | null }>(
        `SELECT published_url FROM articles WHERE id = $1`,
        [articleId],
      )
      return rows[0]?.published_url ?? null
    }

    it('follows it, so the article and its page stay attached', async () => {
      const articleId = await ourPostOnTheShop(OURS, '71')
      await walkWholeStore()
      expect((await rowsByUrl()).get(OURS)?.pageType).toBe('article_ours')

      renameOnTheShop()
      await receiveArticleUpdate('71')

      const rows = await rowsByUrl()
      // The page at the address the shop now serves is ours, and named against
      // the same article. Without this the shop's own post reads back as the
      // merchant's writing and an improve-this-page press hands them edits for
      // words we wrote.
      expect(rows.get(MOVED)?.pageType).toBe('article_ours')
      expect(rows.get(MOVED)?.articleId).toBe(articleId)
      // And the link the merchant clicks to read it opens the live page.
      expect(await addressOf(articleId)).toBe(MOVED)
    })

    it('stops calling the address the shop has abandoned a live page', async () => {
      await ourPostOnTheShop(OURS, '71')
      await walkWholeStore()

      renameOnTheShop()
      await receiveArticleUpdate('71')

      // Our own articles are exempt from the nightly deletion sweep, so without
      // this the old row sits `live` for ever at an address nobody can open and
      // goes on counting as coverage.
      expect((await rowsByUrl()).get(OURS)?.status).toBe('gone')
      const live = await listStorePages(ctx.db, accountScope(accountId))
      expect(live.filter((row) => row.status === 'live').map((row) => row.url)).toContain(MOVED)
    })

    it('cannot follow one on a store we deliver to by export', async () => {
      // The merchant downloaded this article and published it themselves, so
      // the shop believes the post is theirs and gave us no id for it. Export
      // is the default delivery mode, so this is the larger half of stores and
      // the half this answer does not reach.
      const articleId = await ourPublishedArticle(OURS)
      await walkWholeStore()
      expect((await rowsByUrl()).get(OURS)?.pageType).toBe('article_ours')

      renameOnTheShop()
      await receiveArticleUpdate('71')

      const rows = await rowsByUrl()
      expect(rows.get(MOVED)?.pageType).toBe('blog_article')
      expect(rows.get(OURS)?.status).toBe('live')
      expect(await addressOf(articleId)).toBe(OURS)
    })

    it('leaves a post of the merchant’s own entirely alone', async () => {
      const articleId = await ourPostOnTheShop(OURS, '71')
      await walkWholeStore()

      // A different post on the same blog, edited on the same night.
      store.blogs[1]!.articles[1]!.title = 'Your first hike, revised'
      await receiveArticleUpdate('72')

      const rows = await rowsByUrl()
      expect(rows.get('https://shop.example/blogs/guides/first-hike')?.pageType).toBe('blog_article')
      expect(rows.get(OURS)?.pageType).toBe('article_ours')
      expect(rows.get(OURS)?.status).toBe('live')
      expect(await addressOf(articleId)).toBe(OURS)
    })
  })

  it('records nothing at all for a store whose connection is gone', async () => {
    const gone: InventoryTaskDeps = {
      ...deps,
      connections: { ...connected, async readToken() { return undefined } },
    }

    const outcome = await runInventorySync(gone, { accountId })

    expect(outcome.status).toBe('disconnected')
    expect(await listStorePages(ctx.db, accountScope(accountId))).toEqual([])
  })
})
