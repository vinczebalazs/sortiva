import { randomBytes } from 'node:crypto'

export type FixtureProduct = {
  handle: string
  title: string
  productType?: string
  vendor?: string
  status?: 'ACTIVE' | 'DRAFT' | 'ARCHIVED'
  tags?: string[]
  descriptionHtml: string
  options?: { name: string; values: string[] }[]
  price: { min: string; max?: string }
  images?: { url: string; width: number; height: number; altText?: string | null }[]
  collections?: string[]
  metafields?: { namespace: string; key: string; type: string; value: string }[]
}

export type FixtureArticle = { handle: string; title: string; body: string; tags?: string[]; isPublished?: boolean }

export type FixtureStore = {
  shop: {
    name: string
    myshopifyDomain: string
    primaryDomainHost: string
    defaultLocale: string
    country: string
    ianaTimezone: string
    currencyCode: string
  }
  products: FixtureProduct[]
  collections?: { handle: string; title: string; descriptionHtml?: string }[]
  pages?: { handle: string; title: string; body: string }[]
  blogs?: { handle: string; title: string; articles?: FixtureArticle[] }[]
}

export type ProductRecord = FixtureProduct & { id: number; updatedAt: string; collectionIds: number[] }
export type CollectionRecord = { id: number; handle: string; title: string; descriptionHtml: string }
export type PageRecord = { id: number; handle: string; title: string; body: string }
export type BlogRecord = { id: number; handle: string; title: string }
export type ArticleRecord = {
  id: number
  blogId: number
  handle: string
  title: string
  body: string
  summary: string | null
  tags: string[]
  isPublished: boolean
  authorName: string
  metafields: { namespace: string; key: string; type: string; value: string }[]
  createdAt: string
  updatedAt: string
  // Shopify takes a moment before a new article shows up in list queries; the contract run measures it.
  listableAt: number
}

export type Token = { value: string; expiresAt: number; retired?: boolean }

export type ShopState = {
  domain: string
  info: FixtureStore['shop']
  products: ProductRecord[]
  collections: CollectionRecord[]
  pages: PageRecord[]
  blogs: BlogRecord[]
  articles: ArticleRecord[]
  grantedScopes: string[]
  accessTokens: Token[]
  refreshTokens: Token[]
  installed: boolean
  bucket: { available: number; updatedAt: number }
}

let nextId = 7_000_000_000_000

export function newId(): number {
  return ++nextId
}

export function randomToken(prefix: string): string {
  return `${prefix}${randomBytes(16).toString('hex')}`
}

export function loadFixture(fixture: FixtureStore, scopes: string[]): ShopState {
  const now = new Date().toISOString()
  const collections: CollectionRecord[] = (fixture.collections ?? []).map((c) => ({
    id: newId(),
    handle: c.handle,
    title: c.title,
    descriptionHtml: c.descriptionHtml ?? '',
  }))
  const byHandle = new Map(collections.map((c) => [c.handle, c.id]))
  const products: ProductRecord[] = fixture.products.map((p) => ({
    ...p,
    id: newId(),
    updatedAt: now,
    collectionIds: (p.collections ?? []).map((h) => {
      const id = byHandle.get(h)
      if (id === undefined) throw new Error(`fixture product ${p.handle} names unknown collection ${h}`)
      return id
    }),
  }))
  const blogs: BlogRecord[] = []
  const articles: ArticleRecord[] = []
  for (const b of fixture.blogs ?? []) {
    const blog = { id: newId(), handle: b.handle, title: b.title }
    blogs.push(blog)
    for (const a of b.articles ?? []) {
      articles.push({
        id: newId(),
        blogId: blog.id,
        handle: a.handle,
        title: a.title,
        body: a.body,
        summary: null,
        tags: a.tags ?? [],
        isPublished: a.isPublished ?? true,
        authorName: fixture.shop.name,
        metafields: [],
        createdAt: now,
        updatedAt: now,
        listableAt: 0,
      })
    }
  }
  return {
    domain: fixture.shop.myshopifyDomain,
    info: fixture.shop,
    products,
    collections,
    pages: (fixture.pages ?? []).map((p) => ({ id: newId(), ...p })),
    blogs,
    articles,
    grantedScopes: scopes,
    accessTokens: [],
    refreshTokens: [],
    installed: true,
    bucket: { available: 2000, updatedAt: Date.now() },
  }
}

export const gid = (type: string, id: number) => `gid://shopify/${type}/${id}`

export function parseGid(value: string, type: string): number | undefined {
  const match = new RegExp(`^gid://shopify/${type}/(\\d+)$`).exec(value)
  return match ? Number(match[1]) : undefined
}
