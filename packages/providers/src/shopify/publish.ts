import {
  assertShop,
  SHOPIFY_API_VERSION,
} from './oauth'
import { ShopifyApiFailure, ShopifyTokenInvalid, nextPageInfoFrom } from './admin'
import { ShopifyRateLimiters, type ShopifyRateLimiterOptions } from './limiter'
import {
  MarkerLookupIncomplete,
  PUBLISH_MARKER_KEY,
  PUBLISH_MARKER_NAMESPACE,
  RemoteArticleGone,
  SHOPIFY_PUBLISH_SCOPE_PARAM,
  type ArticleAddressing,
  type CreateArticleInput,
  type FindArticleByMarkerInput,
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
 * Every write carries our own marker in a metafield — invisible to the
 * merchant, invisible to their shoppers, and Shopify's own place for data that
 * belongs to an app. That marker is what lets a worker that died mid-publish
 * ask the shop "did my post land?" instead of guessing, which is the difference
 * between a crash costing nothing and a crash costing the merchant a duplicate
 * post.
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
  /**
   * How many pages of a blog's articles one "did my post land?" search will
   * read before giving up and saying so.
   *
   * Tests set it small to prove the giving-up path. In production the
   * creation-time filter means the search sees the handful of posts written
   * since we claimed the publication, so a real search ends on page one; the
   * ceiling exists so a filter the shop ignores cannot turn one question into
   * an unbounded walk of somebody's entire blog.
   */
  maxLookupPages?: number
}

const DEFAULT_MAX_LOOKUP_PAGES = 20

/**
 * How far back the creation-time filter reaches beyond the moment we claimed
 * the publication.
 *
 * Our clock and Shopify's are not the same clock. If theirs is a little behind
 * ours, an article we posted could carry a creation time fractionally earlier
 * than the claim, and a filter set to the exact claim moment would step over
 * the very post it was looking for — and "not found" is the answer that
 * authorises posting again. Five minutes is far more skew than either clock
 * will ever have, and costs nothing: it widens the search by whatever the
 * merchant themselves posted in those five minutes, which is almost always
 * nothing.
 */
const LOOKUP_CLOCK_SKEW_MS = 5 * 60 * 1000

interface RestArticle {
  id?: number
  handle?: string
  title?: string
  published_at?: string | null
  blog_id?: number
}

interface RestMetafield {
  namespace?: string
  key?: string
  value?: string
}

export class ShopifyPublishClient implements ShopifyPublishProvider {
  private readonly apiKey: string
  private readonly fetchImpl: typeof fetch
  private readonly storeBaseUrl: (shop: string) => string
  private readonly limiters: ShopifyRateLimiters
  private readonly maxLookupPages: number

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
    this.maxLookupPages = options.maxLookupPages ?? DEFAULT_MAX_LOOKUP_PAGES
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
   * Two things make this answerable on a blog that has been running for years
   * rather than only on an empty one.
   *
   * It asks the shop for the posts written **since we claimed the
   * publication**, so a blog holding thousands of articles is narrowed to the
   * handful that could possibly be ours. And it follows Shopify's own paging to
   * the end of that narrowed list rather than reading the first page and
   * concluding: a first page is not the list, and treating it as one is exactly
   * how a store with more than 250 posts gets the same article posted twice.
   *
   * The marker itself lives in a metafield, which does not travel in the list
   * response, so each candidate costs one further request to check. That is why
   * the narrowing matters and why the ceiling below exists.
   *
   * A search that runs out of pages **throws** rather than answering "not
   * there". Only a completed search may say no, because saying no is what
   * authorises posting the article again.
   */
  async findArticleByMarker(input: FindArticleByMarkerInput): Promise<RemoteArticle | undefined> {
    const since = new Date(input.notBefore.getTime() - LOOKUP_CLOCK_SKEW_MS).toISOString()
    let path =
      `blogs/${encodeURIComponent(input.blogId)}/articles.json` +
      `?limit=250&fields=id,handle,title,published_at&created_at_min=${encodeURIComponent(since)}`

    for (let page = 0; page < this.maxLookupPages; page += 1) {
      const { body, link } = await this.requestPage<{ articles?: RestArticle[] }>(input, path)
      for (const article of body.articles ?? []) {
        if (!article.id) continue
        if (await this.carriesMarker(input, article.id, input.marker)) {
          return this.toRemote(input, article, input.marker)
        }
      }
      const nextPageInfo = nextPageInfoFrom(link)
      if (!nextPageInfo) return undefined
      // Shopify's cursor stands alone: a page_info request carries the cursor
      // and the page size, and nothing else it was first filtered by.
      path =
        `blogs/${encodeURIComponent(input.blogId)}/articles.json` +
        `?limit=250&page_info=${encodeURIComponent(nextPageInfo)}`
    }

    throw new MarkerLookupIncomplete(input.marker)
  }

  /** One article's marker, read from where the merchant cannot see it. */
  private async carriesMarker(
    credentials: ShopifyStoreCredentials,
    articleId: number,
    marker: string,
  ): Promise<boolean> {
    const body = await this.request<{ metafields?: RestMetafield[] }>(
      credentials,
      'GET',
      `articles/${articleId}/metafields.json` +
        `?namespace=${encodeURIComponent(PUBLISH_MARKER_NAMESPACE)}&key=${encodeURIComponent(PUBLISH_MARKER_KEY)}`,
    )
    return (body.metafields ?? []).some(
      (field) =>
        field.namespace === PUBLISH_MARKER_NAMESPACE &&
        field.key === PUBLISH_MARKER_KEY &&
        field.value === marker,
    )
  }

  private toRemote(
    input: ShopifyStoreCredentials & ArticleAddressing,
    article: RestArticle,
    marker: string,
  ): RemoteArticle {
    const handle = article.handle ?? ''
    const published = Boolean(article.published_at)
    const { blogHandle, storefrontDomain } = input
    return {
      id: String(article.id),
      handle,
      // An unpublished Shopify draft has no address a reader could open, so
      // reporting one would be a link to a 404 — and so would an address built
      // out of the blog's number, which is not how Shopify addresses a post.
      //
      // Built from the store's own domain rather than the host we reach the
      // Admin API through: this address is what a merchant clicks and what a
      // Search Console row has to match, and shoppers are never on the
      // `myshopify.com` one.
      url:
        published && handle && blogHandle && storefrontDomain
          ? `https://${storefrontDomain}/blogs/${blogHandle}/${handle}`
          : null,
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
    return (await this.send<T>(credentials, method, path, payload)).body
  }

  /** The same read, keeping the cursor Shopify puts in the `Link` header. */
  private async requestPage<T>(
    credentials: ShopifyStoreCredentials,
    path: string,
  ): Promise<{ body: T; link: string | null }> {
    return this.send<T>(credentials, 'GET', path)
  }

  private async send<T>(
    credentials: ShopifyStoreCredentials,
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    payload?: unknown,
  ): Promise<{ body: T; link: string | null }> {
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
    return { body: (await response.json()) as T, link: response.headers.get('link') }
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

/**
 * The article as Shopify wants it.
 *
 * The marker goes in a metafield and nowhere else. It used to be written as a
 * tag as well, because a tag comes back in a plain list response and a
 * metafield has to be asked for separately — but tags are the merchant's own
 * vocabulary, shown in their admin and capable of turning up in a storefront
 * tag list their shoppers browse. Nothing we add to somebody's shop should be
 * visible to their customers.
 *
 * There is no `tags` key here at all, rather than an empty one: sending an
 * empty value on a revision would wipe whatever tags the merchant had put on
 * the post themselves.
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
