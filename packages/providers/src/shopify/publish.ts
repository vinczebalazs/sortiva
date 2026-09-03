import {
  assertShop,
  SHOPIFY_API_VERSION,
} from './oauth'
import { ShopifyApiFailure, ShopifyTokenInvalid } from './admin'
import { ShopifyRateLimiters, type ShopifyRateLimiterOptions } from './limiter'
import {
  PUBLISH_MARKER_KEY,
  PUBLISH_MARKER_NAMESPACE,
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
 * The only code in the repository that changes anything in a merchant's shop.
 *
 * It posts articles to one blog and nothing else. It never touches theme code,
 * never writes a redirect, never edits a product — not because those calls are
 * guarded here, but because they are not written anywhere, and this file is the
 * only place they could be.
 *
 * Every write carries our own marker in a metafield, with a tag as the fallback
 * for a store where the metafield write is refused. That marker is what lets a
 * worker that died mid-publish ask the shop "did my post land?" instead of
 * guessing, which is the difference between a crash costing nothing and a crash
 * costing the merchant a duplicate post.
 *
 * REST rather than GraphQL, matching the read client this sits beside: the same
 * pinned API version, the same rate limiter, the same treatment of a rejected
 * token as a failure only the merchant can fix.
 */

export interface ShopifyPublishClientOptions {
  apiKey?: string
  fetchImpl?: typeof fetch
  storeBaseUrl?: (shop: string) => string
  limiter?: ShopifyRateLimiterOptions
}

interface RestArticle {
  id?: number
  handle?: string
  title?: string
  published_at?: string | null
  tags?: string
  blog_id?: number
}

export class ShopifyPublishClient implements ShopifyPublishProvider {
  private readonly apiKey: string
  private readonly fetchImpl: typeof fetch
  private readonly storeBaseUrl: (shop: string) => string
  private readonly limiters: ShopifyRateLimiters

  constructor(options: ShopifyPublishClientOptions = {}) {
    const apiKey = options.apiKey ?? process.env.SHOPIFY_API_KEY
    if (!apiKey) {
      throw new Error(
        'SHOPIFY_API_KEY is not set. Use FakeShopifyPublishClient outside production.',
      )
    }
    this.apiKey = apiKey
    this.fetchImpl = options.fetchImpl ?? fetch
    this.storeBaseUrl = options.storeBaseUrl ?? ((shop) => `https://${shop}.myshopify.com`)
    this.limiters = new ShopifyRateLimiters(options.limiter ?? {})
  }

  /**
   * The second consent screen. A separate method from the install one rather
   * than a scope argument on it, so there is no call that could ask for write
   * permission by accident.
   */
  publishAuthorizeUrl(input: { shop: string; redirectUri: string; state: string }): string {
    assertShop(input.shop)
    const url = new URL(`${this.storeBaseUrl(input.shop)}/admin/oauth/authorize`)
    url.searchParams.set('client_id', this.apiKey)
    url.searchParams.set('scope', SHOPIFY_PUBLISH_SCOPE_PARAM)
    url.searchParams.set('redirect_uri', input.redirectUri)
    url.searchParams.set('state', input.state)
    return url.toString()
  }

  async listBlogs(input: ShopifyStoreCredentials): Promise<readonly ShopifyBlog[]> {
    const body = await this.request<{ blogs?: { id?: number; title?: string; handle?: string }[] }>(
      input,
      'GET',
      'blogs.json?limit=250',
    )
    return (body.blogs ?? []).map((blog) => ({
      id: String(blog.id ?? ''),
      title: blog.title ?? '',
      handle: blog.handle ?? '',
    }))
  }

  async createBlog(input: ShopifyStoreCredentials & { title: string }): Promise<ShopifyBlog> {
    const body = await this.request<{ blog?: { id?: number; title?: string; handle?: string } }>(
      input,
      'POST',
      'blogs.json',
      { blog: { title: input.title } },
    )
    const blog = body.blog
    if (!blog?.id) throw new ShopifyApiFailure('Shopify created no blog.', { retryable: false })
    return { id: String(blog.id), title: blog.title ?? input.title, handle: blog.handle ?? '' }
  }

  async createArticle(input: CreateArticleInput): Promise<RemoteArticle> {
    const body = await this.request<{ article?: RestArticle }>(
      input,
      'POST',
      `blogs/${encodeURIComponent(input.blogId)}/articles.json`,
      { article: articlePayload(input) },
    )
    const article = body.article
    if (!article?.id) {
      throw new ShopifyApiFailure('Shopify accepted the post but named no article.', {
        retryable: false,
      })
    }
    return this.toRemote(input, article, input.marker)
  }

  /**
   * A revision of an article we already published.
   *
   * The remote id is required and there is deliberately no create path out of
   * this method: a merchant who deleted the article meant to, and putting it
   * back under a new id would be a post they never asked for and cannot see
   * coming.
   */
  async updateArticle(input: UpdateArticleInput): Promise<RemoteArticle> {
    const path = `blogs/${encodeURIComponent(input.blogId)}/articles/${encodeURIComponent(input.remoteArticleId)}.json`
    let body: { article?: RestArticle }
    try {
      body = await this.request<{ article?: RestArticle }>(input, 'PUT', path, {
        article: { id: Number(input.remoteArticleId), ...articlePayload(input) },
      })
    } catch (error) {
      if (error instanceof ShopifyNotFound) throw new RemoteArticleGone(input.remoteArticleId)
      throw error
    }
    const article = body.article
    if (!article?.id) throw new RemoteArticleGone(input.remoteArticleId)
    return this.toRemote(input, article, input.marker)
  }

  /**
   * Asks the shop whether an article carrying our marker is already there.
   *
   * Reads the blog's recent articles and matches on the tag rather than
   * querying metafields: a metafield search needs one request per article,
   * which turns a five-minute sweep into a rate-limit problem, while the tag
   * travels with the article in the list response we already have.
   */
  async findArticleByMarker(
    input: ShopifyStoreCredentials & { blogId: string; marker: string },
  ): Promise<RemoteArticle | undefined> {
    const body = await this.request<{ articles?: RestArticle[] }>(
      input,
      'GET',
      `blogs/${encodeURIComponent(input.blogId)}/articles.json?limit=250&fields=id,handle,title,tags,published_at`,
    )
    const found = (body.articles ?? []).find((article) =>
      splitTags(article.tags).includes(input.marker),
    )
    return found?.id ? this.toRemote(input, found, input.marker) : undefined
  }

  private toRemote(
    input: ShopifyStoreCredentials & { blogId?: string },
    article: RestArticle,
    marker: string,
  ): RemoteArticle {
    const handle = article.handle ?? ''
    const published = Boolean(article.published_at)
    return {
      id: String(article.id),
      handle,
      // An unpublished Shopify draft has no address a reader could open, so
      // reporting one would be a link to a 404.
      url: published && handle ? `${this.storeBaseUrl(input.shop)}/blogs/${input.blogId ?? ''}/${handle}` : null,
      marker,
      published,
    }
  }

  private async request<T>(
    credentials: ShopifyStoreCredentials,
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    payload?: unknown,
  ): Promise<T> {
    assertShop(credentials.shop)
    // Paced through the same per-store budget the catalogue walk uses, so a
    // publish never arrives in the middle of a sync and gets both throttled.
    await this.limiters.for(credentials.shop).acquire()

    const url = `${this.storeBaseUrl(credentials.shop)}/admin/api/${SHOPIFY_API_VERSION}/${path}`
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          'X-Shopify-Access-Token': credentials.accessToken,
          accept: 'application/json',
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      })
    } catch (cause) {
      throw new ShopifyApiFailure(`Could not reach Shopify for ${path}.`, { cause })
    }

    if (response.status === 401 || response.status === 403) {
      throw new ShopifyTokenInvalid(credentials.shop, response.status)
    }
    if (response.status === 404) throw new ShopifyNotFound(path)
    if (response.status === 429) {
      const retryAfterMs = retryAfterMsFrom(response.headers.get('retry-after'))
      this.limiters.for(credentials.shop).pauseFor(retryAfterMs)
      throw new ShopifyApiFailure(`Shopify rate-limited ${path}.`, { retryAfterMs })
    }
    if (!response.ok) {
      throw new ShopifyApiFailure(`Shopify answered ${response.status} for ${path}.`, {
        retryable: response.status >= 500,
      })
    }
    return (await response.json()) as T
  }
}

/** A 404 from Shopify, which for an update means the merchant deleted the article. */
export class ShopifyNotFound extends Error {
  override readonly name = 'ShopifyNotFound'
  readonly retryable = false
  readonly errorClass = 'shopify_not_found'
  constructor(readonly path: string) {
    super(`Shopify has nothing at ${path}.`)
  }
}

function retryAfterMsFrom(header: string | null): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  if (!Number.isFinite(seconds) || seconds < 0) return undefined
  return Math.ceil(seconds * 1000)
}

function splitTags(tags: string | undefined): string[] {
  return (tags ?? '')
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)
}

/**
 * The article as Shopify wants it, marker included twice.
 *
 * The metafield is the real marker — invisible to the merchant, and Shopify's
 * own place for app-owned data. The tag is the fallback, and it is written
 * every time rather than only when the metafield fails, because the recovery
 * sweep reads it out of a plain list response; a marker that only exists in a
 * metafield would cost one extra request per article to look for.
 */
function articlePayload(input: CreateArticleInput): Record<string, unknown> {
  return {
    title: input.title,
    body_html: input.bodyHtml,
    handle: input.handle,
    summary_html: input.summary,
    // `published: false` is Shopify's own "save as draft": the article exists
    // on the blog and no reader can see it.
    published: input.publishAs === 'live',
    tags: input.marker,
    metafields: [
      {
        namespace: PUBLISH_MARKER_NAMESPACE,
        key: PUBLISH_MARKER_KEY,
        type: 'single_line_text_field',
        value: input.marker,
      },
    ],
  }
}
