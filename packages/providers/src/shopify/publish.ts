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
  type ShopifyAuth,
  type ShopifyBlog,
  type ShopifyPublishProvider,
  type ShopifyStoreCredentials,
  type UpdateArticleInput,
} from '@sortiva/core'
import { assertShop } from './oauth'
import {
  ShopifyApiFailure,
  ShopifyGraphqlClient,
  gidOf,
  legacyIdOf,
  type ShopifyGraphqlClientOptions,
} from './graphql'

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
 */

export type ShopifyPublishClientOptions = ShopifyGraphqlClientOptions & {
  clientId?: string
  /** An already-built transport, so publishing and reading share one store's pacing. */
  graphql?: ShopifyGraphqlClient
  /**
   * How many pages of the shop's recent posts one "did my post land?" search
   * reads before giving up and saying so.
   *
   * In production the creation-time filter means the search sees the handful of
   * posts written since we claimed the publication, so a real search ends on
   * page one; the ceiling exists so a shop that somehow answered with an
   * endless list cannot turn one question into an unbounded walk.
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

/** The search fields Shopify keeps an article's search title and description in. */
const SEO_TITLE_KEY = 'title_tag'
const SEO_DESCRIPTION_KEY = 'description_tag'
const SEO_NAMESPACE = 'global'

const ARTICLE_FIELDS = `
  id
  handle
  title
  isPublished
  blog { id handle }
  marker: metafield(namespace: "${PUBLISH_MARKER_NAMESPACE}", key: "${PUBLISH_MARKER_KEY}") { value }`

const BLOGS_QUERY = `query SortivaBlogs($first: Int!, $after: String) {
  blogs(first: $first, after: $after, sortKey: ID) {
    pageInfo { hasNextPage endCursor }
    nodes { id title handle }
  }
}`

const BLOG_BY_HANDLE_QUERY = `query SortivaBlogByHandle($query: String!) {
  blogs(first: 2, query: $query) { nodes { id title handle } }
}`

const BLOG_CREATE = `mutation SortivaBlogCreate($blog: BlogCreateInput!) {
  blogCreate(blog: $blog) {
    blog { id title handle }
    userErrors { field message }
  }
}`

const ARTICLE_CREATE = `mutation SortivaArticleCreate($article: ArticleCreateInput!) {
  articleCreate(article: $article) {
    article { ${ARTICLE_FIELDS} }
    userErrors { field message code }
  }
}`

const ARTICLE_UPDATE = `mutation SortivaArticleUpdate($id: ID!, $article: ArticleUpdateInput!) {
  articleUpdate(id: $id, article: $article) {
    article { ${ARTICLE_FIELDS} }
    userErrors { field message code }
  }
}`

const ARTICLES_SINCE_QUERY = `query SortivaArticlesSince($first: Int!, $after: String, $query: String!) {
  articles(first: $first, after: $after, sortKey: ID, query: $query) {
    pageInfo { hasNextPage endCursor }
    nodes { ${ARTICLE_FIELDS} }
  }
}`

interface RawArticle {
  readonly id?: string
  readonly handle?: string
  readonly title?: string
  readonly isPublished?: boolean
  readonly blog?: { readonly id?: string; readonly handle?: string } | null
  readonly marker?: { readonly value?: string | null } | null
}

interface RawBlog {
  readonly id?: string
  readonly title?: string
  readonly handle?: string
}

interface UserError {
  readonly field?: readonly string[] | null
  readonly message?: string
  readonly code?: string
}

export class ShopifyPublishClient implements ShopifyPublishProvider {
  private readonly clientId: string
  private readonly graphql: ShopifyGraphqlClient
  private readonly maxLookupPages: number

  constructor(options: ShopifyPublishClientOptions = {}) {
    const clientId = options.clientId ?? process.env.SHOPIFY_CLIENT_ID
    if (!clientId) {
      throw new Error(
        'SHOPIFY_CLIENT_ID is not set. Use FakeShopifyPublishClient outside production.',
      )
    }
    this.clientId = clientId
    this.graphql = options.graphql ?? new ShopifyGraphqlClient(options)
    this.maxLookupPages = options.maxLookupPages ?? DEFAULT_MAX_LOOKUP_PAGES
  }

  /**
   * The second consent screen. A separate method from the install one rather
   * than a scope argument on it, so there is no call that could ask for write
   * permission by accident.
   */
  publishAuthorizeUrl(input: { shop: string; redirectUri: string; state: string }): string {
    assertShop(input.shop)
    const url = new URL(`https://${input.shop}.myshopify.com/admin/oauth/authorize`)
    url.searchParams.set('client_id', this.clientId)
    url.searchParams.set('scope', SHOPIFY_PUBLISH_SCOPE_PARAM)
    url.searchParams.set('redirect_uri', input.redirectUri)
    url.searchParams.set('state', input.state)
    return url.toString()
  }

  async listBlogs(input: ShopifyStoreCredentials): Promise<readonly ShopifyBlog[]> {
    const blogs: ShopifyBlog[] = []
    let after: string | undefined
    // Followed to the end: a store with more blogs than one page holds would
    // otherwise be offered a picker missing the blog it wanted.
    for (let page = 0; page < 20; page += 1) {
      const data = await this.graphql.request<{
        blogs?: { nodes?: RawBlog[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } }
      }>(input.auth, {
        query: BLOGS_QUERY,
        variables: { first: 100, after: after ?? null },
        expectedCost: 110,
      })
      blogs.push(...(data.blogs?.nodes ?? []).map(toBlog))
      if (!data.blogs?.pageInfo?.hasNextPage) return blogs
      after = data.blogs.pageInfo.endCursor ?? undefined
      if (!after) return blogs
    }
    return blogs
  }

  /**
   * One click, for a store that has no blog to post to yet.
   *
   * Repeat-safe on purpose: a merchant double-clicking, or a client retrying a
   * request whose answer was lost, must not leave two identical blogs on their
   * store. A blog already carrying the handle we would have taken is answered
   * with rather than added to.
   */
  async createBlog(input: ShopifyStoreCredentials & { title: string }): Promise<ShopifyBlog> {
    const handle = blogHandleFor(input.title)
    const existing = await this.blogByHandle(input.auth, handle)
    if (existing) return existing

    const data = await this.graphql.request<{
      blogCreate?: { blog?: RawBlog | null; userErrors?: UserError[] }
    }>(input.auth, {
      query: BLOG_CREATE,
      variables: { blog: { title: input.title, handle } },
      expectedCost: 10,
    })
    const refused = data.blogCreate?.userErrors ?? []
    if (refused.length > 0) {
      // Two clicks a moment apart can both find no blog and both try to create
      // one; the loser is told the handle is taken, and the blog it wanted is
      // now there.
      const taken = await this.blogByHandle(input.auth, handle)
      if (taken) return taken
      throw refusal('Shopify would not create the blog', refused)
    }
    const blog = data.blogCreate?.blog
    if (!blog?.id) throw new ShopifyApiFailure('Shopify created no blog.', { retryable: false })
    return toBlog(blog)
  }

  async createArticle(input: CreateArticleInput): Promise<RemoteArticle> {
    const data = await this.graphql.request<{
      articleCreate?: { article?: RawArticle | null; userErrors?: UserError[] }
    }>(input.auth, {
      query: ARTICLE_CREATE,
      variables: {
        article: {
          blogId: gidOf('Blog', input.blogId),
          title: input.title,
          handle: input.handle,
          body: input.bodyHtml,
          summary: input.summary,
          author: { name: input.author },
          // `isPublished: false` is Shopify's own "save as draft": the article
          // exists on the blog and no reader can see it.
          isPublished: input.publishAs === 'live',
          metafields: metafieldsFor(input),
          ...(input.image ? { image: { url: input.image.url, altText: input.image.alt ?? input.title } } : {}),
        },
      },
      expectedCost: 20,
    })
    const refused = data.articleCreate?.userErrors ?? []
    if (refused.length > 0) throw refusal('Shopify would not post the article', refused)
    const article = data.articleCreate?.article
    if (!article?.id) {
      throw new ShopifyApiFailure('Shopify accepted the post but named no article.', {
        retryable: false,
      })
    }
    return toRemote(article, input)
  }

  /**
   * A revision of an article we already published.
   *
   * The remote id is required and there is deliberately no create path out of
   * this method: a merchant who deleted the article meant to, and putting it
   * back under a new id would be a post they never asked for and cannot see
   * coming.
   *
   * It names the article and nothing else about where it lives, so a merchant
   * who has since pointed us at a different blog keeps their older posts
   * mended in place rather than duplicated into the new one.
   *
   * It sends the words we wrote and nothing else. Shopify leaves an unsent
   * field alone, so the merchant's own rename, their own tags and their
   * decision to take the post down all survive a repair.
   */
  async updateArticle(input: UpdateArticleInput): Promise<RemoteArticle> {
    const data = await this.graphql.request<{
      articleUpdate?: { article?: RawArticle | null; userErrors?: UserError[] }
    }>(input.auth, {
      query: ARTICLE_UPDATE,
      variables: {
        id: gidOf('Article', input.remoteArticleId),
        article: {
          title: input.title,
          body: input.bodyHtml,
          summary: input.summary,
        },
      },
      expectedCost: 20,
    })
    const refused = data.articleUpdate?.userErrors ?? []
    if (refused.some((error) => error.code === 'NOT_FOUND')) {
      throw new RemoteArticleGone(input.remoteArticleId)
    }
    if (refused.length > 0) throw refusal('Shopify would not revise the article', refused)
    const article = data.articleUpdate?.article
    if (!article?.id) throw new RemoteArticleGone(input.remoteArticleId)
    return toRemote(article, input)
  }

  /**
   * Asks the shop whether an article carrying our marker is already there.
   *
   * Two things make this answerable on a shop that has been publishing for
   * years rather than only on an empty one. It asks for the posts written
   * **since we claimed the publication**, so a shop holding thousands of
   * articles is narrowed to the handful that could possibly be ours. And the
   * marker comes back with each post rather than costing a request of its own.
   *
   * It searches the whole shop rather than one blog, because the blog a post
   * went to is the blog that was chosen at the time, and a merchant may have
   * chosen a different one since. Searching only the current target is how a
   * crash either side of that change ends with the same article posted twice.
   *
   * A search that runs out of pages **throws** rather than answering "not
   * there". Only a completed search may say no, because saying no is what
   * authorises posting the article again.
   */
  async findArticleByMarker(input: FindArticleByMarkerInput): Promise<RemoteArticle | undefined> {
    const since = new Date(input.notBefore.getTime() - LOOKUP_CLOCK_SKEW_MS).toISOString()
    let after: string | undefined

    for (let page = 0; page < this.maxLookupPages; page += 1) {
      const data = await this.graphql.request<{
        articles?: { nodes?: RawArticle[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } }
      }>(input.auth, {
        query: ARTICLES_SINCE_QUERY,
        variables: { first: 100, after: after ?? null, query: `created_at:>='${since}'` },
        expectedCost: 110,
        // "Posted since we started" has to mean exactly that: a filter Shopify
        // ignored would hand back the oldest posts on the blog instead, and a
        // search that then found nothing would authorise posting again.
        strictSearch: true,
      })
      for (const article of data.articles?.nodes ?? []) {
        if (article.marker?.value === input.marker) return toRemote(article, input)
      }
      if (!data.articles?.pageInfo?.hasNextPage) return undefined
      after = data.articles.pageInfo.endCursor ?? undefined
      if (!after) return undefined
    }

    throw new MarkerLookupIncomplete(input.marker)
  }

  private async blogByHandle(auth: ShopifyAuth, handle: string): Promise<ShopifyBlog | undefined> {
    const data = await this.graphql.request<{ blogs?: { nodes?: RawBlog[] } }>(auth, {
      query: BLOG_BY_HANDLE_QUERY,
      variables: { query: `handle:'${handle}'` },
      expectedCost: 10,
      strictSearch: true,
    })
    const found = (data.blogs?.nodes ?? []).find((blog) => blog.handle === handle)
    return found ? toBlog(found) : undefined
  }
}

/**
 * The article's public address, built whether or not it is live yet.
 *
 * The blog is the one the post actually sits on, as Shopify just reported it,
 * rather than whichever blog is currently chosen as the target.
 */
function toRemote(article: RawArticle, addressing: ArticleAddressing): RemoteArticle {
  const handle = article.handle ?? ''
  const blogHandle = article.blog?.handle ?? ''
  const { storefrontDomain } = addressing
  return {
    id: legacyIdOf(article.id),
    handle,
    blogHandle,
    url:
      handle && blogHandle && storefrontDomain
        ? `https://${storefrontDomain}/blogs/${blogHandle}/${handle}`
        : null,
    marker: article.marker?.value ?? null,
    published: article.isPublished ?? false,
  }
}

function toBlog(blog: RawBlog): ShopifyBlog {
  return { id: legacyIdOf(blog.id), title: blog.title ?? '', handle: blog.handle ?? '' }
}

/**
 * What travels with a new post besides its words: our marker, and the search
 * title and description.
 *
 * The marker goes in a metafield and nowhere else. It used to be written as a
 * tag as well, because a tag comes back in a plain list response and a
 * metafield had to be asked for separately — but tags are the merchant's own
 * vocabulary, shown in their admin and capable of turning up in a storefront
 * tag list their shoppers browse. Nothing we add to somebody's shop should be
 * visible to their customers.
 *
 * The search fields are Shopify's own: `global.title_tag` and
 * `global.description_tag` are where every Shopify theme reads a post's search
 * title and description from.
 */
function metafieldsFor(input: CreateArticleInput): Record<string, string>[] {
  const fields = [
    {
      namespace: PUBLISH_MARKER_NAMESPACE,
      key: PUBLISH_MARKER_KEY,
      type: 'single_line_text_field',
      value: input.marker,
    },
  ]
  if (input.seoTitle) {
    fields.push({
      namespace: SEO_NAMESPACE,
      key: SEO_TITLE_KEY,
      type: 'single_line_text_field',
      value: input.seoTitle,
    })
  }
  if (input.seoDescription) {
    fields.push({
      namespace: SEO_NAMESPACE,
      key: SEO_DESCRIPTION_KEY,
      type: 'multi_line_text_field',
      value: input.seoDescription,
    })
  }
  return fields
}

/**
 * A refusal Shopify states in its answer rather than in the status code.
 *
 * Non-retryable by construction: the shop read the request and would not accept
 * it, so sending the same thing again gets the same answer. It is also a
 * positive "nothing was written", which is what lets the publishing job release
 * its claim instead of leaving the article in doubt.
 */
function refusal(what: string, errors: readonly UserError[]): ShopifyApiFailure {
  const detail = errors
    .map((error) => `${(error.field ?? []).join('.') || 'request'}: ${error.message ?? 'refused'}`)
    .join('; ')
  return new ShopifyApiFailure(`${what}: ${detail}`, { retryable: false })
}

/** Shopify's own shape for a handle: lower case, words joined by hyphens. */
function blogHandleFor(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'news'
  )
}
