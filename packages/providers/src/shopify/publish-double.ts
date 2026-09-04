import {
  MarkerLookupIncomplete,
  RemoteArticleGone,
  SHOPIFY_PUBLISH_SCOPE_PARAM,
  type CreateArticleInput,
  type FindArticleByMarkerInput,
  type RemoteArticle,
  type ShopifyBlog,
  type ShopifyPublishProvider,
  type ShopifyStoreCredentials,
  type UpdateArticleInput,
} from '@sortiva/core'

/**
 * A shop that remembers what was posted to it.
 *
 * There is no Shopify development store in this environment, so this is what
 * the publishing protocol is proven against: it holds the articles that have
 * been created, answers the marker search from them, and can be told to fail or
 * to lose an article at any point. That is enough to demonstrate the property
 * that matters — a worker killed between posting and recording the post still
 * leaves exactly one article on the shop — which a live store could show
 * happening but could not show being *impossible*.
 *
 * **It has to be able to fail the way a real shop fails.** An earlier version
 * answered "did my post land?" by searching its entire memory in one go, so the
 * question always got the right answer here and the wrong one against a real
 * blog with more posts than fit in a single response — which is precisely why a
 * defect that could post a merchant's article twice sat in the code untested.
 * So this hands back one page at a time, of a size a test can shrink; it keeps
 * the marker where a real shop keeps it, in a metafield that has to be asked
 * for per article rather than in the list; and it refuses to say "not there"
 * when it ran out of pages before it ran out of articles.
 *
 * `calls` is the record a test asserts against: two creates for one article is
 * the failure the whole two-phase protocol exists to prevent, and it is visible
 * here as a list rather than inferred from a count. `list_page` and `metafield`
 * entries are what prove a search really paged rather than peeked.
 */

/** One article on the fake shop, including what a list response would not show. */
interface FakeArticle extends RemoteArticle {
  readonly blogId: string
  readonly blogHandle: string
  /** The host this shop's articles are addressed under, as the caller gave it. */
  readonly storefrontDomain: string
  readonly bodyHtml: string
  readonly title: string
  /** When the shop says it was created — what the creation-time filter reads. */
  readonly createdAt: Date
  /** Where the real marker lives: not in the list response, and not visible to the merchant. */
  readonly metafieldMarker: string
  /**
   * The merchant's own tags. We never send any, and a revision must not clear
   * the ones they added — which is only demonstrable if the shop holds them.
   */
  readonly tags: readonly string[]
}

export type FakeShopCall = {
  op: 'create' | 'update' | 'find' | 'list' | 'create_blog' | 'list_page' | 'metafield'
  marker?: string
}

export interface FakeShopifyPublishClientOptions {
  /** How many articles one page of the blog's list holds. Shopify's own ceiling is 250. */
  pageSize?: number
  /** How many pages one search reads before it refuses to answer. */
  maxLookupPages?: number
  /** The shop's clock, for stamping when an article was created. */
  now?: () => Date
}

/** Matches the real client's allowance for our clock and the shop's disagreeing. */
const LOOKUP_CLOCK_SKEW_MS = 5 * 60 * 1000

export class FakeShopifyPublishClient implements ShopifyPublishProvider {
  readonly blogs: ShopifyBlog[] = []
  /** Every article on the fake shop, keyed by its remote id. */
  readonly articles = new Map<string, FakeArticle>()
  readonly calls: FakeShopCall[] = []

  /** Thrown by the next write, whatever it is. Set by a test to simulate a shop that is down. */
  failNextWith?: Error

  readonly pageSize: number
  readonly maxLookupPages: number
  private readonly now: () => Date

  private nextId = 1

  constructor(
    blogs: readonly ShopifyBlog[] = [{ id: 'blog-1', title: 'News', handle: 'news' }],
    options: FakeShopifyPublishClientOptions = {},
  ) {
    this.blogs.push(...blogs)
    this.pageSize = options.pageSize ?? 250
    this.maxLookupPages = options.maxLookupPages ?? 20
    this.now = options.now ?? (() => new Date())
  }

  publishAuthorizeUrl(input: { shop: string; redirectUri: string; state: string }): string {
    const url = new URL(`https://${input.shop}.myshopify.com/admin/oauth/authorize`)
    url.searchParams.set('client_id', 'test-key')
    url.searchParams.set('scope', SHOPIFY_PUBLISH_SCOPE_PARAM)
    url.searchParams.set('redirect_uri', input.redirectUri)
    url.searchParams.set('state', input.state)
    return url.toString()
  }

  async listBlogs(_input: ShopifyStoreCredentials): Promise<readonly ShopifyBlog[]> {
    this.calls.push({ op: 'list' })
    return this.blogs
  }

  async createBlog(input: ShopifyStoreCredentials & { title: string }): Promise<ShopifyBlog> {
    this.calls.push({ op: 'create_blog' })
    const blog = {
      id: `blog-${this.blogs.length + 1}`,
      title: input.title,
      handle: input.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    }
    this.blogs.push(blog)
    return blog
  }

  async createArticle(input: CreateArticleInput): Promise<RemoteArticle> {
    this.calls.push({ op: 'create', marker: input.marker })
    this.throwIfArmed()
    return this.put({
      id: `remote-${this.nextId++}`,
      handle: input.handle,
      blogId: input.blogId,
      blogHandle: input.blogHandle,
      storefrontDomain: input.storefrontDomain,
      shop: input.shop,
      title: input.title,
      bodyHtml: input.bodyHtml,
      marker: input.marker,
      published: input.publishAs === 'live',
    })
  }

  async updateArticle(input: UpdateArticleInput): Promise<RemoteArticle> {
    this.calls.push({ op: 'update', marker: input.marker })
    this.throwIfArmed()
    const existing = this.articles.get(input.remoteArticleId)
    // The deleted-remotely case. A test that wants it deletes the article from
    // `articles` and calls update; nothing here may answer by creating one.
    if (!existing) throw new RemoteArticleGone(input.remoteArticleId)
    // Shopify leaves an unsent field alone, and so does this: the handle, the
    // published state, the address and any tags stay whatever the merchant last
    // made them. A double that reset them would let a repair which overwrites a
    // merchant's rename pass its tests.
    const updated: FakeArticle = {
      ...existing,
      title: input.title,
      bodyHtml: input.bodyHtml,
      marker: input.marker,
      metafieldMarker: input.marker,
    }
    this.articles.set(input.remoteArticleId, updated)
    return updated
  }

  /**
   * The search a real shop makes expensive: one page of the blog at a time, and
   * one request per article to read a marker the list does not carry.
   */
  async findArticleByMarker(input: FindArticleByMarkerInput): Promise<RemoteArticle | undefined> {
    this.calls.push({ op: 'find', marker: input.marker })

    const since = input.notBefore.getTime() - LOOKUP_CLOCK_SKEW_MS
    const candidates = [...this.articles.values()]
      .filter((article) => article.blogId === input.blogId && article.createdAt.getTime() >= since)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())

    for (let page = 0; page < this.maxLookupPages; page += 1) {
      const offset = page * this.pageSize
      if (offset >= candidates.length) return undefined
      this.calls.push({ op: 'list_page' })
      for (const article of candidates.slice(offset, offset + this.pageSize)) {
        this.calls.push({ op: 'metafield' })
        if (article.metafieldMarker === input.marker) return article
      }
      if (offset + this.pageSize >= candidates.length) return undefined
    }

    // More blog than the search was allowed to read. Answering "not there"
    // would authorise posting the article a second time.
    throw new MarkerLookupIncomplete(input.marker)
  }

  /** Puts an article on the shop directly, the way a merchant's own posts got there. */
  plantArticle(input: {
    blogId: string
    blogHandle: string
    shop: string
    handle: string
    /** Defaults to the shop's own host, which is where a merchant's own posts sit. */
    storefrontDomain?: string
    title?: string
    marker?: string
    createdAt?: Date
  }): RemoteArticle {
    return this.put({
      id: `remote-${this.nextId++}`,
      handle: input.handle,
      blogId: input.blogId,
      blogHandle: input.blogHandle,
      storefrontDomain: input.storefrontDomain ?? `${input.shop}.myshopify.com`,
      shop: input.shop,
      title: input.title ?? input.handle,
      bodyHtml: '',
      marker: input.marker ?? '',
      published: true,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    })
  }

  private put(input: {
    id: string
    handle: string
    blogId: string
    blogHandle: string
    storefrontDomain: string
    shop: string
    title: string
    bodyHtml: string
    marker: string
    published: boolean
    createdAt?: Date
    tags?: readonly string[]
  }): FakeArticle {
    const article: FakeArticle = {
      id: input.id,
      handle: input.handle,
      // The address a shopper would open: the store's own domain, and the
      // blog's *name* rather than its number.
      url: input.published
        ? `https://${input.storefrontDomain}/blogs/${input.blogHandle}/${input.handle}`
        : null,
      marker: input.marker,
      published: input.published,
      blogId: input.blogId,
      blogHandle: input.blogHandle,
      storefrontDomain: input.storefrontDomain,
      bodyHtml: input.bodyHtml,
      title: input.title,
      createdAt: input.createdAt ?? this.now(),
      metafieldMarker: input.marker,
      tags: input.tags ?? [],
    }
    this.articles.set(article.id, article)
    return article
  }

  /** How many articles carry this marker. The number the chaos test asserts is exactly one. */
  countByMarker(marker: string): number {
    let n = 0
    for (const article of this.articles.values()) if (article.metafieldMarker === marker) n += 1
    return n
  }

  private throwIfArmed(): void {
    const error = this.failNextWith
    if (!error) return
    this.failNextWith = undefined as Error | undefined
    throw error
  }
}
