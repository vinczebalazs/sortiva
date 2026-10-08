/** What the core needs from a store platform. Shopify is the first implementation. */

export type ShopInfo = {
  name: string
  domain: string
  storefrontHost: string
  primaryLocale: string | null
  country: string | null
  timezone: string
  currency: string
}

export type ConnectorImage = { url: string; width: number | null; height: number | null; altText: string | null }

export type ConnectorProduct = {
  platformId: string
  handle: string
  title: string
  productType: string
  vendor: string
  status: string
  tags: string[]
  descriptionHtml: string
  onlineStoreUrl: string | null
  options: { name: string; values: string[] }[]
  priceMin: number | null
  priceMax: number | null
  currency: string | null
  images: ConnectorImage[]
  collections: { platformId: string; handle: string; title: string }[]
  metafields: { namespace: string; key: string; type: string; value: string }[]
}

export type ConnectorPage = {
  kind: 'article' | 'page' | 'collection' | 'blog'
  platformId: string
  handle: string
  url: string
  title: string
  excerptHtml: string
  marker: string | null
}

export type RemoteArticle = { remoteId: string; handle: string; url: string; bodyHtml: string; published: boolean; marker: string | null }

export type ArticleInput = {
  blogId: string
  title: string
  handle: string
  bodyHtml: string
  summaryHtml: string
  published: boolean
  author: string
  marker: string
}

export type Page<T> = { items: T[]; nextCursor: string | null }

export interface StoreConnector {
  shopInfo(): Promise<ShopInfo>
  grantedScopes(): Promise<string[]>
  productCount(): Promise<number>
  productsPage(cursor: string | null, pageSize: number): Promise<Page<ConnectorProduct>>
  product(platformId: string): Promise<ConnectorProduct | null>
  /** Collections, pages, blogs and blog articles that already exist on the store. */
  existingContent(): Promise<ConnectorPage[]>
  blogs(): Promise<{ platformId: string; handle: string; title: string }[]>
  createBlog(title: string): Promise<{ platformId: string; handle: string }>
  createArticle(input: ArticleInput): Promise<RemoteArticle>
  /** Never creates: a missing article is reported, not replaced. */
  updateArticle(remoteId: string, input: Partial<Omit<ArticleInput, 'blogId' | 'marker'>>): Promise<RemoteArticle | 'not_found'>
  article(remoteId: string): Promise<RemoteArticle | null>
  findArticleByMarker(marker: string, createdAfter: Date): Promise<RemoteArticle | null>
}

/** The store refused because a permission was not granted or was taken back. */
export class PermissionLostError extends Error {
  constructor(readonly scope: string, message: string) {
    super(message)
  }
}

/** Our access to the store is gone: refresh failed or the token was revoked. */
export class AccessLostError extends Error {}

/** Worth retrying later: network, 5xx, throttle that would not clear. */
export class TransientStoreError extends Error {}
