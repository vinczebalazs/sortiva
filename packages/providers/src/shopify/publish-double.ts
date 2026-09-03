import {
  RemoteArticleGone,
  SHOPIFY_PUBLISH_SCOPE_PARAM,
  type CreateArticleInput,
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
 * `calls` is the record a test asserts against: two creates for one article is
 * the failure the whole two-phase protocol exists to prevent, and it is visible
 * here as a list rather than inferred from a count.
 */
export class FakeShopifyPublishClient implements ShopifyPublishProvider {
  readonly blogs: ShopifyBlog[] = []
  /** Every article on the fake shop, keyed by its remote id. */
  readonly articles = new Map<string, RemoteArticle & { blogId: string; bodyHtml: string; title: string }>()
  readonly calls: { op: 'create' | 'update' | 'find' | 'list' | 'create_blog'; marker?: string }[] = []

  /** Thrown by the next write, whatever it is. Set by a test to simulate a shop that is down. */
  failNextWith?: Error

  private nextId = 1

  constructor(blogs: readonly ShopifyBlog[] = [{ id: 'blog-1', title: 'News', handle: 'news' }]) {
    this.blogs.push(...blogs)
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
    const id = `remote-${this.nextId++}`
    const published = input.publishAs === 'live'
    const article = {
      id,
      handle: input.handle,
      url: published ? `https://${input.shop}.myshopify.com/blogs/${input.blogId}/${input.handle}` : null,
      marker: input.marker,
      published,
      blogId: input.blogId,
      bodyHtml: input.bodyHtml,
      title: input.title,
    }
    this.articles.set(id, article)
    return article
  }

  async updateArticle(input: UpdateArticleInput): Promise<RemoteArticle> {
    this.calls.push({ op: 'update', marker: input.marker })
    this.throwIfArmed()
    const existing = this.articles.get(input.remoteArticleId)
    // The deleted-remotely case. A test that wants it deletes the article from
    // `articles` and calls update; nothing here may answer by creating one.
    if (!existing) throw new RemoteArticleGone(input.remoteArticleId)
    const updated = { ...existing, title: input.title, bodyHtml: input.bodyHtml, marker: input.marker }
    this.articles.set(input.remoteArticleId, updated)
    return updated
  }

  async findArticleByMarker(
    input: ShopifyStoreCredentials & { blogId: string; marker: string },
  ): Promise<RemoteArticle | undefined> {
    this.calls.push({ op: 'find', marker: input.marker })
    for (const article of this.articles.values()) {
      if (article.marker === input.marker && article.blogId === input.blogId) return article
    }
    return undefined
  }

  /** How many articles carry this marker. The number the chaos test asserts is exactly one. */
  countByMarker(marker: string): number {
    let n = 0
    for (const article of this.articles.values()) if (article.marker === marker) n += 1
    return n
  }

  private throwIfArmed(): void {
    const error = this.failNextWith
    if (!error) return
    this.failNextWith = undefined as Error | undefined
    throw error
  }
}
