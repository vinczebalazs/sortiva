import type {
  InventoryCursor,
  InventoryTarget,
  StoreContentBatch,
  StoreContentRecord,
  StoreContentSource,
} from '@sortiva/core'
import type { ShopifyAdminReader, ShopifyCredentials } from './deps'

/** What the Admin client wants: which store, and the token to read it with. */
interface AdminAuth {
  readonly shop: string
  readonly accessToken: string
}

/**
 * Reading a Shopify store's published things through its admin interface.
 *
 * The store tells us what it has; we never go and look. Everything here is a
 * list the merchant could open in their own admin — collections, products,
 * pages, blogs and their articles.
 *
 * The walk is staged and resumable. Shopify allows roughly one request a second,
 * so a large store is a long walk that has to survive being killed halfway; the
 * cursor names the stage and the last id read, and the job hands it back to the
 * queue when it runs out of budget.
 */

/**
 * The order the store is walked in, and it is not arbitrary: collections come
 * first because they carry product membership, which is what gives every later
 * row its product families.
 *
 * Shopify keeps hand-picked and rule-based collections in two different lists
 * with no combined endpoint, so both are walked.
 */
const STAGES = ['custom_collection', 'smart_collection', 'product', 'page', 'blog_article'] as const
type Stage = (typeof STAGES)[number]

/** Shopify's own cap on a list request. */
const MAX_PAGE_SIZE = 250

interface ShopifyResource {
  id: number | string
  handle?: string
  title?: string
  body_html?: string | null
  updated_at?: string
}

export interface ShopifyInventorySourceOptions {
  /**
   * How many of a collection's products to read when working out which families
   * it covers. One request's worth: a collection with more members than this
   * already tells us everything about which families it is about, and paging
   * through a thousand-product collection nightly would buy nothing.
   */
  readonly membershipSampleSize?: number
}

export class ShopifyInventorySource implements StoreContentSource {
  private readonly origins = new Map<string, string>()
  private readonly blogHandles = new Map<string, string>()

  constructor(
    private readonly admin: ShopifyAdminReader,
    private readonly credentials: (accountId: string) => Promise<ShopifyCredentials>,
    private readonly options: ShopifyInventorySourceOptions = {},
  ) {}

  /**
   * The address the store actually serves on, asked of the store itself.
   *
   * Not the domain the merchant claimed with us: search engines report the
   * canonical storefront address, and an inventory spelled the other way would
   * never join against the search data it exists to be compared with.
   */
  async storefrontOrigin(accountId: string): Promise<string> {
    const cached = this.origins.get(accountId)
    if (cached) return cached
    const auth = await this.auth(accountId)
    const body = await this.admin.get<{ shop?: { domain?: string; myshopify_domain?: string } }>(
      auth,
      'shop.json',
    )
    const host = body.shop?.domain ?? body.shop?.myshopify_domain ?? `${auth.shop}.myshopify.com`
    const origin = `https://${host}`
    this.origins.set(accountId, origin)
    return origin
  }

  async next(
    accountId: string,
    cursor: InventoryCursor | undefined,
    limit: number,
  ): Promise<StoreContentBatch> {
    const auth = await this.auth(accountId)
    const stage = stageOf(cursor) ?? STAGES[0]
    const sinceId = cursor?.['sinceId']
    const pageSize = Math.min(Math.max(limit, 1), MAX_PAGE_SIZE)

    const page = await this.readStage(auth, stage, cursor, sinceId, pageSize)
    const records = await this.enrich(auth, page.records)

    // Blog posts work out their own next step, because they are two levels deep.
    if (page.next) return { records, ...page.next }

    // A full page means there is more of this stage; a short one means this
    // stage has been walked to its end and the next call starts the following
    // one. Running off the last stage is what says the store is done.
    return page.records.length >= pageSize
      ? { records, next: withinStage(stage, cursor, page.lastId) }
      : { records, ...nextStage(stage) }
  }

  /**
   * Re-reads exactly the things a webhook named.
   *
   * A thing the store no longer has is dropped rather than raised: by the time
   * we ask, a merchant who deleted a page has already deleted it, and that is
   * the ordinary case rather than a fault.
   */
  async read(
    accountId: string,
    targets: readonly InventoryTarget[],
  ): Promise<readonly StoreContentRecord[]> {
    const auth = await this.auth(accountId)
    const found: StoreContentRecord[] = []
    for (const target of targets) {
      const record = await this.readOne(auth, target)
      if (record) found.push(record)
    }
    return this.enrich(auth, found)
  }

  private async readOne(
    auth: AdminAuth,
    target: InventoryTarget,
  ): Promise<StoreContentRecord | undefined> {
    try {
      switch (target.kind) {
        case 'collection': {
          const body = await this.admin.get<{ collection?: ShopifyResource }>(
            auth,
            `collections/${target.shopifyId}.json`,
          )
          return body.collection ? toRecord(body.collection, 'collection') : undefined
        }
        case 'product': {
          const body = await this.admin.get<{ product?: ShopifyResource }>(
            auth,
            `products/${target.shopifyId}.json`,
          )
          return body.product ? toRecord(body.product, 'product') : undefined
        }
        case 'page': {
          const body = await this.admin.get<{ page?: ShopifyResource }>(
            auth,
            `pages/${target.shopifyId}.json`,
          )
          return body.page ? toRecord(body.page, 'page') : undefined
        }
        case 'blog_article': {
          const body = await this.admin.get<{
            article?: ShopifyResource & { blog_id?: number | string }
          }>(auth, `articles/${target.shopifyId}.json`)
          if (!body.article) return undefined
          const blogHandle = await this.blogHandle(auth, body.article.blog_id)
          return { ...toRecord(body.article, 'blog_article'), blogHandle }
        }
      }
    } catch (error) {
      if (isGone(error)) return undefined
      throw error
    }
  }

  /**
   * A blog post's address contains its blog's handle, and the article record
   * names only the blog's id. The list is small and rarely changes, so it is
   * read once per process rather than per article.
   */
  private async blogHandle(auth: AdminAuth, blogId: number | string | undefined): Promise<string> {
    if (blogId === undefined) return 'news'
    if (this.blogHandles.size === 0) {
      const blogs = await this.admin.get<{ blogs?: { id: number | string; handle?: string }[] }>(
        auth,
        'blogs.json?limit=250',
      )
      for (const blog of blogs.blogs ?? []) {
        this.blogHandles.set(String(blog.id), blog.handle ?? String(blog.id))
      }
    }
    return this.blogHandles.get(String(blogId)) ?? String(blogId)
  }

  private async readStage(
    auth: AdminAuth,
    stage: Stage,
    cursor: InventoryCursor | undefined,
    sinceId: string | undefined,
    pageSize: number,
  ): Promise<{ records: StoreContentRecord[]; lastId?: string; next?: { next?: InventoryCursor } }> {
    switch (stage) {
      case 'custom_collection':
      case 'smart_collection': {
        const key = stage === 'custom_collection' ? 'custom_collections' : 'smart_collections'
        const body = await this.admin.get<Record<string, ShopifyResource[]>>(
          auth,
          listPath(`${key}.json`, pageSize, sinceId),
        )
        const raw = body[key] ?? []
        return {
          records: raw.map((item) => toRecord(item, 'collection')),
          ...lastIdOf(raw),
        }
      }
      case 'product': {
        const body = await this.admin.get<{ products?: ShopifyResource[] }>(
          auth,
          listPath('products.json', pageSize, sinceId),
        )
        const raw = body.products ?? []
        return { records: raw.map((item) => toRecord(item, 'product')), ...lastIdOf(raw) }
      }
      case 'page': {
        const body = await this.admin.get<{ pages?: ShopifyResource[] }>(
          auth,
          listPath('pages.json', pageSize, sinceId),
        )
        const raw = body.pages ?? []
        return { records: raw.map((item) => toRecord(item, 'page')), ...lastIdOf(raw) }
      }
      case 'blog_article':
        return this.readArticles(auth, cursor, sinceId, pageSize)
    }
  }

  /**
   * Blog posts are two levels deep: a store has blogs, and each blog has
   * articles. The cursor carries which blog is being read as well as how far
   * into it we are, so a store with several blogs resumes in the right one.
   */
  private async readArticles(
    auth: AdminAuth,
    cursor: InventoryCursor | undefined,
    sinceId: string | undefined,
    pageSize: number,
  ): Promise<{ records: StoreContentRecord[]; lastId?: string; next?: { next?: InventoryCursor } }> {
    const blogs = await this.admin.get<{ blogs?: { id: number | string; handle?: string }[] }>(
      auth,
      'blogs.json?limit=250',
    )
    const list = blogs.blogs ?? []
    const index = Number(cursor?.['blogIndex'] ?? '0')
    const blog = list[index]
    if (!blog) return { records: [], next: {} }

    const body = await this.admin.get<{ articles?: ShopifyResource[] }>(
      auth,
      listPath(`blogs/${blog.id}/articles.json`, pageSize, sinceId),
    )
    const raw = body.articles ?? []
    const records = raw.map((item) => ({
      ...toRecord(item, 'blog_article'),
      blogHandle: blog.handle ?? String(blog.id),
    }))

    if (raw.length >= pageSize) {
      return {
        records,
        next: {
          next: { stage: 'blog_article', blogIndex: String(index), sinceId: String(raw[raw.length - 1]!.id) },
        },
      }
    }
    // This blog is finished. Move to the next one, or off the last stage.
    return index + 1 < list.length
      ? { records, next: { next: { stage: 'blog_article', blogIndex: String(index + 1) } } }
      : { records, next: {} }
  }

  /**
   * Fills in the two search fields and, for collections, which products are in
   * them.
   *
   * Shopify's REST interface does not put a page's search title and description
   * in the page itself — they are metafields, one request each. That is the
   * dominant cost of this walk and the reason it is batched and resumable. Its
   * GraphQL interface returns them inline for 250 pages at a time, which is the
   * cheaper answer and belongs with the Shopify client rather than here — see
   * DECISIONS 2026-09-02 T3.2.
   */
  private async enrich(
    auth: AdminAuth,
    records: readonly StoreContentRecord[],
  ): Promise<StoreContentRecord[]> {
    const out: StoreContentRecord[] = []
    for (const record of records) {
      const seo = await this.readSeo(auth, record)
      const members =
        record.kind === 'collection' ? await this.readMembership(auth, record.shopifyId) : undefined
      out.push({
        ...record,
        seoTitle: seo.title,
        seoDescription: seo.description,
        ...(members ? { memberProductIds: members } : {}),
      })
    }
    return out
  }

  private async readSeo(
    auth: AdminAuth,
    record: StoreContentRecord,
  ): Promise<{ title: string | null; description: string | null }> {
    const owner = metafieldOwnerPath(record)
    const body = await this.admin.get<{
      metafields?: { namespace?: string; key?: string; value?: unknown }[]
    }>(auth, `${owner}/metafields.json?namespace=global`)
    const fields = body.metafields ?? []
    return {
      title: valueOf(fields, 'title_tag'),
      description: valueOf(fields, 'description_tag'),
    }
  }

  private async readMembership(auth: AdminAuth, collectionId: string): Promise<string[]> {
    const size = this.options.membershipSampleSize ?? MAX_PAGE_SIZE
    const body = await this.admin.get<{ products?: { id: number | string }[] }>(
      auth,
      `collections/${collectionId}/products.json?limit=${size}`,
    )
    return (body.products ?? []).map((product) => String(product.id))
  }

  private async auth(accountId: string): Promise<AdminAuth> {
    const credentials = await this.credentials(accountId)
    return { shop: credentials.shopHandle, accessToken: credentials.accessToken }
  }
}

/** Shopify answers 404 for something a merchant has already deleted. */
function isGone(error: unknown): boolean {
  return error instanceof Error && /answered 404/.test(error.message)
}

function stageOf(cursor: InventoryCursor | undefined): Stage | undefined {
  const stage = cursor?.['stage']
  return STAGES.includes(stage as Stage) ? (stage as Stage) : undefined
}

function withinStage(
  stage: Stage,
  cursor: InventoryCursor | undefined,
  lastId: string | undefined,
): InventoryCursor {
  const blogIndex = cursor?.['blogIndex']
  return {
    stage,
    ...(lastId ? { sinceId: lastId } : {}),
    ...(blogIndex ? { blogIndex } : {}),
  }
}

function nextStage(stage: Stage): { next?: InventoryCursor } {
  const following = STAGES[STAGES.indexOf(stage) + 1]
  return following ? { next: { stage: following } } : {}
}

/**
 * Paging by "everything after this id".
 *
 * Shopify's newer paging returns its cursor in a response header, which the
 * shared Admin client does not surface; asking for ids after the last one we saw
 * needs nothing but the response body. It also makes the walk restartable from
 * any point, which is what the resume relies on.
 */
function listPath(path: string, pageSize: number, sinceId: string | undefined): string {
  const join = path.includes('?') ? '&' : '?'
  const since = sinceId ? `&since_id=${encodeURIComponent(sinceId)}` : ''
  return `${path}${join}limit=${pageSize}${since}`
}

function lastIdOf(raw: readonly ShopifyResource[]): { lastId?: string } {
  const last = raw[raw.length - 1]
  return last ? { lastId: String(last.id) } : {}
}

function toRecord(item: ShopifyResource, kind: StoreContentRecord['kind']): StoreContentRecord {
  return {
    kind,
    shopifyId: String(item.id),
    handle: item.handle ?? String(item.id),
    title: item.title ?? '',
    bodyHtml: item.body_html ?? null,
    seoTitle: null,
    seoDescription: null,
    ...(item.updated_at ? { updatedAt: item.updated_at } : {}),
  }
}

function metafieldOwnerPath(record: StoreContentRecord): string {
  switch (record.kind) {
    case 'collection':
      return `collections/${record.shopifyId}`
    case 'product':
      return `products/${record.shopifyId}`
    case 'page':
      return `pages/${record.shopifyId}`
    case 'blog_article':
      return `articles/${record.shopifyId}`
  }
}

function valueOf(
  fields: readonly { namespace?: string; key?: string; value?: unknown }[],
  key: string,
): string | null {
  const field = fields.find((candidate) => candidate.key === key && candidate.namespace === 'global')
  if (!field || field.value === null || field.value === undefined) return null
  const value = String(field.value).trim()
  return value === '' ? null : value
}
