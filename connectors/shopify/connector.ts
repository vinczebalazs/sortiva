import type {
  ArticleInput,
  ConnectorPage,
  ConnectorProduct,
  Page,
  RemoteArticle,
  ShopInfo,
  StoreConnector,
} from '../types.ts'
import type { ShopifyClient } from './client.ts'
import * as q from './queries.ts'

type Connection<T> = { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }

type ProductNode = {
  id: string
  handle: string
  title: string
  productType: string
  vendor: string
  status: string
  tags: string[]
  descriptionHtml: string
  onlineStoreUrl: string | null
  options: { name: string; optionValues: { name: string }[] }[]
  priceRangeV2: { minVariantPrice: { amount: string; currencyCode: string }; maxVariantPrice: { amount: string; currencyCode: string } }
  media: { nodes: ({ image?: { url: string; width: number | null; height: number | null; altText: string | null } | null } | Record<string, never>)[] }
  collections: { nodes: { id: string; handle: string; title: string }[] }
  metafields: { nodes: { namespace: string; key: string; type: string; value: string }[] }
}

type ArticleNode = {
  id: string
  handle: string
  title?: string
  body: string
  isPublished: boolean
  createdAt?: string
  blog: { id: string; handle: string }
  marker: { value: string } | null
}

const PAGE = 100

function toProduct(node: ProductNode): ConnectorProduct {
  return {
    platformId: node.id,
    handle: node.handle,
    title: node.title,
    productType: node.productType,
    vendor: node.vendor,
    status: node.status,
    tags: node.tags,
    descriptionHtml: node.descriptionHtml,
    onlineStoreUrl: node.onlineStoreUrl,
    options: node.options.map((o) => ({ name: o.name, values: o.optionValues.map((v) => v.name) })),
    priceMin: Number(node.priceRangeV2.minVariantPrice.amount),
    priceMax: Number(node.priceRangeV2.maxVariantPrice.amount),
    currency: node.priceRangeV2.minVariantPrice.currencyCode,
    images: node.media.nodes.flatMap((m) => ('image' in m && m.image ? [m.image] : [])),
    collections: node.collections.nodes.map((c) => ({ platformId: c.id, handle: c.handle, title: c.title })),
    metafields: node.metafields.nodes,
  }
}

export class ShopifyConnector implements StoreConnector {
  private storefrontHost: string | null = null

  constructor(private readonly client: ShopifyClient) {}

  async shopInfo(): Promise<ShopInfo> {
    const { shop } = await this.client.request<{
      shop: {
        name: string
        myshopifyDomain: string
        ianaTimezone: string
        currencyCode: string
        primaryDomain: { host: string; localization: { defaultLocale: string; country: string | null } | null }
        shopAddress: { countryCodeV2: string | null }
      }
    }>(q.SHOP)
    this.storefrontHost = shop.primaryDomain.host
    return {
      name: shop.name,
      domain: shop.myshopifyDomain,
      storefrontHost: shop.primaryDomain.host,
      primaryLocale: shop.primaryDomain.localization?.defaultLocale ?? null,
      country: shop.primaryDomain.localization?.country ?? shop.shopAddress.countryCodeV2,
      timezone: shop.ianaTimezone,
      currency: shop.currencyCode,
    }
  }

  async grantedScopes(): Promise<string[]> {
    const data = await this.client.request<{ currentAppInstallation: { accessScopes: { handle: string }[] } }>(q.APP_SCOPES)
    return data.currentAppInstallation.accessScopes.map((s) => s.handle)
  }

  async productCount(): Promise<number> {
    return (await this.client.request<{ productsCount: { count: number } | null }>(q.PRODUCTS_COUNT)).productsCount?.count ?? 0
  }

  async productsPage(cursor: string | null, pageSize: number): Promise<Page<ConnectorProduct>> {
    const { products } = await this.client.request<{ products: Connection<ProductNode> }>(q.PRODUCTS_PAGE, { first: pageSize, after: cursor })
    return { items: products.nodes.map(toProduct), nextCursor: products.pageInfo.hasNextPage ? products.pageInfo.endCursor : null }
  }

  async product(platformId: string): Promise<ConnectorProduct | null> {
    const { product } = await this.client.request<{ product: ProductNode | null }>(q.PRODUCT, { id: platformId })
    return product ? toProduct(product) : null
  }

  private async all<N>(document: string, field: string): Promise<N[]> {
    const out: N[] = []
    let after: string | null = null
    do {
      const data: Record<string, Connection<N>> = await this.client.request(document, { first: PAGE, after })
      const conn = data[field]!
      out.push(...conn.nodes)
      after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null
    } while (after)
    return out
  }

  private async host(): Promise<string> {
    return this.storefrontHost ?? (await this.shopInfo()).storefrontHost
  }

  async existingContent(): Promise<ConnectorPage[]> {
    const host = await this.host()
    const collections = await this.all<{ id: string; handle: string; title: string; descriptionHtml: string }>(q.COLLECTIONS_PAGE, 'collections')
    const pages = await this.all<{ id: string; handle: string; title: string; body: string }>(q.PAGES_PAGE, 'pages')
    const blogs = await this.blogs()
    const articles = await this.all<ArticleNode & { title: string }>(q.ARTICLES_PAGE, 'articles')
    return [
      ...collections.map((c) => ({ kind: 'collection' as const, platformId: c.id, handle: c.handle, url: `https://${host}/collections/${c.handle}`, title: c.title, excerptHtml: c.descriptionHtml, marker: null })),
      ...pages.map((p) => ({ kind: 'page' as const, platformId: p.id, handle: p.handle, url: `https://${host}/pages/${p.handle}`, title: p.title, excerptHtml: p.body, marker: null })),
      ...blogs.map((b) => ({ kind: 'blog' as const, platformId: b.platformId, handle: b.handle, url: `https://${host}/blogs/${b.handle}`, title: b.title, excerptHtml: '', marker: null })),
      ...articles.map((a) => ({
        kind: 'article' as const,
        platformId: a.id,
        handle: a.handle,
        url: `https://${host}/blogs/${a.blog.handle}/${a.handle}`,
        title: a.title,
        excerptHtml: a.body,
        marker: a.marker?.value ?? null,
      })),
    ]
  }

  async blogs(): Promise<{ platformId: string; handle: string; title: string }[]> {
    const nodes = await this.all<{ id: string; handle: string; title: string }>(q.BLOGS, 'blogs')
    return nodes.map((b) => ({ platformId: b.id, handle: b.handle, title: b.title }))
  }

  async createBlog(title: string): Promise<{ platformId: string; handle: string }> {
    const { blogCreate } = await this.client.request<{
      blogCreate: { blog: { id: string; handle: string } | null; userErrors: { message: string }[] }
    }>(q.BLOG_CREATE, { blog: { title } })
    if (!blogCreate.blog) throw new Error(`Shopify refused to create the blog: ${blogCreate.userErrors.map((e) => e.message).join('; ')}`)
    return { platformId: blogCreate.blog.id, handle: blogCreate.blog.handle }
  }

  private async remote(node: { id: string; handle: string; isPublished: boolean; blog: { handle: string } }, body: string, marker: string | null): Promise<RemoteArticle> {
    return { remoteId: node.id, handle: node.handle, url: `https://${await this.host()}/blogs/${node.blog.handle}/${node.handle}`, bodyHtml: body, published: node.isPublished, marker }
  }

  async createArticle(input: ArticleInput): Promise<RemoteArticle> {
    const { articleCreate } = await this.client.request<{
      articleCreate: { article: { id: string; handle: string; isPublished: boolean; blog: { id: string; handle: string } } | null; userErrors: { message: string; code: string }[] }
    }>(q.ARTICLE_CREATE, {
      article: {
        blogId: input.blogId,
        title: input.title,
        handle: input.handle,
        body: input.bodyHtml,
        summary: input.summaryHtml,
        isPublished: input.published,
        author: { name: input.author },
        metafields: [{ namespace: q.MARKER_NAMESPACE, key: q.MARKER_KEY, type: 'single_line_text_field', value: input.marker }],
      },
    })
    if (!articleCreate.article) throw new Error(`Shopify refused to create the article: ${articleCreate.userErrors.map((e) => `${e.code}: ${e.message}`).join('; ')}`)
    return this.remote(articleCreate.article, input.bodyHtml, input.marker)
  }

  async updateArticle(remoteId: string, input: Partial<Omit<ArticleInput, 'blogId' | 'marker'>>): Promise<RemoteArticle | 'not_found'> {
    const article: Record<string, unknown> = {}
    if (input.title !== undefined) article.title = input.title
    if (input.handle !== undefined) article.handle = input.handle
    if (input.bodyHtml !== undefined) article.body = input.bodyHtml
    if (input.summaryHtml !== undefined) article.summary = input.summaryHtml
    if (input.published !== undefined) article.isPublished = input.published
    const { articleUpdate } = await this.client.request<{
      articleUpdate: { article: { id: string; handle: string; isPublished: boolean; blog: { id: string; handle: string } } | null; userErrors: { message: string; code: string }[] }
    }>(q.ARTICLE_UPDATE, { id: remoteId, article })
    if (!articleUpdate.article) {
      if (articleUpdate.userErrors.some((e) => e.code === 'NOT_FOUND')) return 'not_found'
      throw new Error(`Shopify refused to update the article: ${articleUpdate.userErrors.map((e) => e.message).join('; ')}`)
    }
    const current = await this.article(remoteId)
    return current ?? this.remote(articleUpdate.article, input.bodyHtml ?? '', null)
  }

  async article(remoteId: string): Promise<RemoteArticle | null> {
    const { article } = await this.client.request<{ article: ArticleNode | null }>(q.ARTICLE, { id: remoteId })
    return article ? this.remote(article, article.body, article.marker?.value ?? null) : null
  }

  async findArticleByMarker(marker: string, createdAfter: Date): Promise<RemoteArticle | null> {
    let after: string | null = null
    for (;;) {
      const { articles }: { articles: Connection<ArticleNode> } = await this.client.request(q.RECENT_ARTICLES_WITH_MARKER, { first: 50, after })
      for (const node of articles.nodes) {
        if (node.marker?.value === marker) return this.remote(node, node.body, marker)
      }
      const oldest = articles.nodes.at(-1)?.createdAt
      // Newest first: once past the intent's creation time, an older article cannot be ours.
      if (!articles.pageInfo.hasNextPage || (oldest && new Date(oldest) < createdAfter)) return null
      after = articles.pageInfo.endCursor
    }
  }
}
