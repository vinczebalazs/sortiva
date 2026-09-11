import type {
  ShopifyAuth,
  ShopifyMetafield,
  ShopifyOrder,
  ShopifyProduct,
  StoreContentKind,
  StoreContentRecord,
} from '@sortiva/core'
import { ShopifyGraphqlClient, gidOf, legacyIdOf, type ShopifyGraphqlClientOptions } from './graphql'

/**
 * Everything the product reads out of a merchant's store.
 *
 * One client, so the pacing, the token renewal and the treatment of each kind
 * of refusal are inherited by every read rather than re-implemented per caller.
 * Callers ask for products, orders or store pages; the queries, Shopify's ids
 * and its paging live here, and what comes back is in our own shapes.
 *
 * Two rules run through it. Only fields we actually use are asked for — on
 * orders that is also the first line of the customer-data defence, because a
 * field never requested never crosses the network. And every list is followed
 * to its end through Shopify's cursors, never read once and treated as
 * complete.
 */

/** The handful of shop fields the connect screen, the persona and publishing need. */
export interface ShopProfile {
  /** Shopify's numeric id for the store, as a string. */
  readonly id: string
  readonly name: string
  readonly myshopifyDomain: string
  /**
   * The host shoppers actually visit. Search Console reports a store's traffic
   * under this one, and an article recorded under the `myshopify` host could
   * never be matched to the clicks it earns.
   */
  readonly primaryDomain: string | null
  readonly countryCode: string | null
  readonly currency: string | null
  /** The shop owner's own working clock, which is also the clock its orders are dated by. */
  readonly ianaTimezone: string | null
  /**
   * The language the storefront is configured in, e.g. `de`. The strongest
   * evidence there is for what language we should write in: a statement the
   * merchant made rather than anything we inferred.
   *
   * Read off the primary domain rather than from the shop's locale list, which
   * needs a permission of its own that we deliberately do not ask for.
   */
  readonly primaryLocale: string | null
}

/** One page of a list, and where the next one starts. */
export interface ShopifyListPage<T> {
  readonly items: readonly T[]
  /** Shopify's cursor for the following page, or undefined at the end of the list. */
  readonly next: string | undefined
}

export interface OrdersPage extends ShopifyListPage<ShopifyOrder> {
  /** The store's own time zone, which is what its orders' calendar days are counted in. */
  readonly timeZone: string | null
}

/** How many of each thing one page asks for. Sized so a page stays inside Shopify's per-query cost ceiling. */
const PAGE_SIZE = {
  products: 50,
  variants: 100,
  media: 10,
  metafields: 50,
  orders: 50,
  lineItems: 100,
  content: 100,
  members: 250,
} as const

const SHOP_QUERY = `query SortivaShop {
  shop {
    id
    name
    myshopifyDomain
    ianaTimezone
    currencyCode
    shopAddress { countryCodeV2 }
    primaryDomain { host localization { defaultLocale } }
  }
}`

const PRODUCT_FIELDS = `
  legacyResourceId
  title
  descriptionHtml
  handle
  productType
  vendor
  tags
  status
  updatedAt
  options(first: 10) { name position values }
  variants(first: ${PAGE_SIZE.variants}) {
    pageInfo { hasNextPage endCursor }
    nodes { legacyResourceId title sku price compareAtPrice availableForSale }
  }
  media(first: ${PAGE_SIZE.media}) { nodes { ... on MediaImage { image { url altText } } } }
  metafields(first: ${PAGE_SIZE.metafields}) {
    pageInfo { hasNextPage endCursor }
    nodes { namespace key value type }
  }`

const PRODUCTS_QUERY = `query SortivaProducts($first: Int!, $after: String) {
  products(first: $first, after: $after, sortKey: ID) {
    pageInfo { hasNextPage endCursor }
    nodes { ${PRODUCT_FIELDS} }
  }
}`

const PRODUCT_QUERY = `query SortivaProduct($id: ID!) {
  product(id: $id) { ${PRODUCT_FIELDS} }
}`

const PRODUCT_VARIANTS_QUERY = `query SortivaProductVariants($id: ID!, $after: String) {
  product(id: $id) {
    variants(first: 250, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { legacyResourceId title sku price compareAtPrice availableForSale }
    }
  }
}`

const PRODUCT_METAFIELDS_QUERY = `query SortivaProductMetafields($id: ID!, $after: String) {
  product(id: $id) {
    metafields(first: 250, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { namespace key value type }
    }
  }
}`

const ORDERS_QUERY = `query SortivaOrders($first: Int!, $after: String, $query: String!) {
  shop { ianaTimezone }
  orders(first: $first, after: $after, sortKey: CREATED_AT, query: $query) {
    pageInfo { hasNextPage endCursor }
    nodes {
      legacyResourceId
      createdAt
      currencyCode
      test
      cancelledAt
      customerJourneySummary { lastVisit { landingPage } }
      lineItems(first: ${PAGE_SIZE.lineItems}) {
        pageInfo { hasNextPage endCursor }
        nodes {
          title
          quantity
          currentQuantity
          isGiftCard
          product { legacyResourceId }
          discountedUnitPriceAfterAllDiscountsSet { shopMoney { amount } }
        }
      }
    }
  }
}`

const ORDER_LINE_ITEMS_QUERY = `query SortivaOrderLineItems($id: ID!, $after: String) {
  order(id: $id) {
    lineItems(first: 250, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        title
        quantity
        currentQuantity
        isGiftCard
        product { legacyResourceId }
        discountedUnitPriceAfterAllDiscountsSet { shopMoney { amount } }
      }
    }
  }
}`

/**
 * The search fields the SEO title and description of a page or a post live in.
 * Shopify keeps them as metafields there, while products and collections have
 * a field of their own for them.
 */
const SEO_METAFIELDS = `metafields(namespace: "global", keys: ["title_tag", "description_tag"], first: 2) { nodes { key value } }`

const CONTENT_QUERIES: Readonly<Record<StoreContentKind, string>> = {
  collection: `query SortivaCollections($first: Int!, $after: String) {
    collections(first: $first, after: $after, sortKey: ID) {
      pageInfo { hasNextPage endCursor }
      nodes { legacyResourceId handle title descriptionHtml updatedAt seo { title description } }
    }
  }`,
  // Only products a shopper can reach: a draft is not a page anything of ours
  // may treat as already covering a topic.
  product: `query SortivaContentProducts($first: Int!, $after: String) {
    products(first: $first, after: $after, sortKey: ID, query: "status:active") {
      pageInfo { hasNextPage endCursor }
      nodes { legacyResourceId handle title descriptionHtml updatedAt seo { title description } }
    }
  }`,
  page: `query SortivaPages($first: Int!, $after: String) {
    pages(first: $first, after: $after, sortKey: ID) {
      pageInfo { hasNextPage endCursor }
      nodes { id handle title body updatedAt isPublished ${SEO_METAFIELDS} }
    }
  }`,
  blog_article: `query SortivaArticles($first: Int!, $after: String) {
    articles(first: $first, after: $after, sortKey: ID) {
      pageInfo { hasNextPage endCursor }
      nodes { id handle title body updatedAt isPublished blog { handle } ${SEO_METAFIELDS} }
    }
  }`,
}

const CONTENT_ONE_QUERIES: Readonly<Record<StoreContentKind, string>> = {
  collection: `query SortivaCollection($id: ID!) {
    collection(id: $id) { legacyResourceId handle title descriptionHtml updatedAt seo { title description } }
  }`,
  product: `query SortivaContentProduct($id: ID!) {
    product(id: $id) { legacyResourceId handle title descriptionHtml updatedAt status seo { title description } }
  }`,
  page: `query SortivaPage($id: ID!) {
    page(id: $id) { id handle title body updatedAt isPublished ${SEO_METAFIELDS} }
  }`,
  blog_article: `query SortivaArticle($id: ID!) {
    article(id: $id) { id handle title body updatedAt isPublished blog { handle } ${SEO_METAFIELDS} }
  }`,
}

const COLLECTION_MEMBERS_QUERY = `query SortivaCollectionMembers($id: ID!, $first: Int!) {
  collection(id: $id) { products(first: $first) { nodes { legacyResourceId } } }
}`

/** Shopify's own name for each kind, for building the global ids its queries take. */
const GID_TYPE: Readonly<Record<StoreContentKind, string>> = {
  collection: 'Collection',
  product: 'Product',
  page: 'Page',
  blog_article: 'Article',
}

export type ShopifyAdminClientOptions = ShopifyGraphqlClientOptions & {
  /** An already-built transport, so several clients can share one store's pacing. */
  graphql?: ShopifyGraphqlClient
}

export class ShopifyAdminClient {
  private readonly graphql: ShopifyGraphqlClient

  constructor(options: ShopifyAdminClientOptions = {}) {
    this.graphql = options.graphql ?? new ShopifyGraphqlClient(options)
  }

  /**
   * The store's own record. Read right after a token is granted, which turns
   * "Shopify handed us a string" into "we have confirmed this token can read
   * this store" before the merchant is told they are connected.
   */
  async getShop(auth: ShopifyAuth): Promise<ShopProfile> {
    const data = await this.graphql.request<{ shop?: RawShop }>(auth, {
      query: SHOP_QUERY,
      expectedCost: 5,
    })
    const shop = data.shop ?? {}
    return {
      id: legacyIdOf(shop.id),
      name: shop.name ?? '',
      myshopifyDomain: shop.myshopifyDomain ?? `${auth.shop}.myshopify.com`,
      primaryDomain: nonEmpty(shop.primaryDomain?.host),
      countryCode: nonEmpty(shop.shopAddress?.countryCodeV2),
      currency: nonEmpty(shop.currencyCode),
      ianaTimezone: nonEmpty(shop.ianaTimezone),
      primaryLocale: nonEmpty(shop.primaryDomain?.localization?.defaultLocale),
    }
  }

  /** One page of the catalogue, products complete with their variants and metafields. */
  async listProducts(
    auth: ShopifyAuth,
    options: { after?: string; first?: number } = {},
  ): Promise<ShopifyListPage<ShopifyProduct>> {
    const data = await this.graphql.request<{ products?: RawConnection<RawProduct> }>(auth, {
      query: PRODUCTS_QUERY,
      variables: { first: options.first ?? PAGE_SIZE.products, after: options.after ?? null },
      expectedCost: 250,
    })
    const nodes = data.products?.nodes ?? []
    const products: ShopifyProduct[] = []
    for (const node of nodes) products.push(await this.completeProduct(auth, node))
    return { items: products, next: cursorOf(data.products) }
  }

  /** One product by its numeric id, for a re-read a webhook asked for. */
  async getProduct(auth: ShopifyAuth, productId: string): Promise<ShopifyProduct | undefined> {
    const data = await this.graphql.request<{ product?: RawProduct | null }>(auth, {
      query: PRODUCT_QUERY,
      variables: { id: gidOf('Product', productId) },
      expectedCost: 20,
    })
    return data.product ? this.completeProduct(auth, data.product) : undefined
  }

  /**
   * Orders placed since `createdFrom`, oldest first, carrying only what may be
   * kept: the day, the landing page, and the lines.
   *
   * The order of the answer is load-bearing further up: totals for a day can be
   * written out and dropped as soon as an order from a later day appears.
   */
  async listOrders(
    auth: ShopifyAuth,
    options: { createdFrom: Date; after?: string; first?: number },
  ): Promise<OrdersPage> {
    const data = await this.graphql.request<{
      shop?: { ianaTimezone?: string | null }
      orders?: RawConnection<RawOrder>
    }>(auth, {
      query: ORDERS_QUERY,
      variables: {
        first: options.first ?? PAGE_SIZE.orders,
        after: options.after ?? null,
        query: `created_at:>='${options.createdFrom.toISOString()}'`,
      },
      expectedCost: 300,
      // "Orders since that moment" has to mean exactly that. A filter Shopify
      // ignored would hand back the whole history as though it were the window.
      strictSearch: true,
    })
    const nodes = data.orders?.nodes ?? []
    const orders: ShopifyOrder[] = []
    for (const node of nodes) orders.push(await this.completeOrder(auth, node))
    return {
      items: orders,
      next: cursorOf(data.orders),
      timeZone: nonEmpty(data.shop?.ianaTimezone),
    }
  }

  /** One page of the store's own published things, of one kind. */
  async listContent(
    auth: ShopifyAuth,
    options: { kind: StoreContentKind; after?: string; first?: number },
  ): Promise<ShopifyListPage<StoreContentRecord>> {
    const data = await this.graphql.request<Record<string, RawConnection<RawContent>>>(auth, {
      query: CONTENT_QUERIES[options.kind],
      variables: { first: options.first ?? PAGE_SIZE.content, after: options.after ?? null },
      expectedCost: 200,
    })
    const connection = Object.values(data)[0]
    const records = (connection?.nodes ?? [])
      .filter((node) => node.isPublished !== false)
      .map((node) => toContentRecord(node, options.kind))
    return { items: records, next: cursorOf(connection) }
  }

  /** One of the store's things by id, for a re-read a webhook asked for. */
  async readContent(
    auth: ShopifyAuth,
    target: { kind: StoreContentKind; shopifyId: string },
  ): Promise<StoreContentRecord | undefined> {
    const data = await this.graphql.request<Record<string, RawContent | null>>(auth, {
      query: CONTENT_ONE_QUERIES[target.kind],
      variables: { id: gidOf(GID_TYPE[target.kind], target.shopifyId) },
      expectedCost: 10,
    })
    // Shopify answers with a null node for something the merchant has already
    // deleted, which is the ordinary case rather than a fault.
    const node = Object.values(data)[0]
    if (!node) return undefined
    if (node.isPublished === false || node.status === 'DRAFT') return undefined
    return toContentRecord(node, target.kind)
  }

  /** Which products a collection holds, up to one page: enough to say what it is about. */
  async collectionMemberIds(
    auth: ShopifyAuth,
    collectionId: string,
    first = PAGE_SIZE.members,
  ): Promise<readonly string[]> {
    const data = await this.graphql.request<{
      collection?: { products?: { nodes?: { legacyResourceId?: string }[] } } | null
    }>(auth, {
      query: COLLECTION_MEMBERS_QUERY,
      variables: { id: gidOf('Collection', collectionId), first },
      expectedCost: first,
    })
    return (data.collection?.products?.nodes ?? []).map((node) => String(node.legacyResourceId ?? ''))
  }

  /**
   * A product with the rest of its variants and metafields, for the rare store
   * that keeps more of either than one page holds. A product with the ordinary
   * handful costs no extra request.
   */
  private async completeProduct(auth: ShopifyAuth, raw: RawProduct): Promise<ShopifyProduct> {
    const variants = [...(raw.variants?.nodes ?? [])]
    let variantCursor = raw.variants?.pageInfo?.hasNextPage ? raw.variants.pageInfo.endCursor : undefined
    while (variantCursor) {
      const page = await this.graphql.request<{ product?: { variants?: RawConnection<RawVariant> } }>(auth, {
        query: PRODUCT_VARIANTS_QUERY,
        variables: { id: gidOf('Product', String(raw.legacyResourceId ?? '')), after: variantCursor },
        expectedCost: 250,
      })
      variants.push(...(page.product?.variants?.nodes ?? []))
      variantCursor = cursorOf(page.product?.variants)
    }

    const metafields = [...(raw.metafields?.nodes ?? [])]
    let metafieldCursor = raw.metafields?.pageInfo?.hasNextPage ? raw.metafields.pageInfo.endCursor : undefined
    while (metafieldCursor) {
      const page = await this.graphql.request<{ product?: { metafields?: RawConnection<RawMetafield> } }>(auth, {
        query: PRODUCT_METAFIELDS_QUERY,
        variables: { id: gidOf('Product', String(raw.legacyResourceId ?? '')), after: metafieldCursor },
        expectedCost: 250,
      })
      metafields.push(...(page.product?.metafields?.nodes ?? []))
      metafieldCursor = cursorOf(page.product?.metafields)
    }

    return toProduct(raw, variants, metafields)
  }

  /** An order with the rest of its lines, for the rare order longer than one page. */
  private async completeOrder(auth: ShopifyAuth, raw: RawOrder): Promise<ShopifyOrder> {
    const lines = [...(raw.lineItems?.nodes ?? [])]
    let cursor = raw.lineItems?.pageInfo?.hasNextPage ? raw.lineItems.pageInfo.endCursor : undefined
    while (cursor) {
      const page = await this.graphql.request<{ order?: { lineItems?: RawConnection<RawLineItem> } }>(auth, {
        query: ORDER_LINE_ITEMS_QUERY,
        variables: { id: gidOf('Order', String(raw.legacyResourceId ?? '')), after: cursor },
        expectedCost: 250,
      })
      lines.push(...(page.order?.lineItems?.nodes ?? []))
      cursor = cursorOf(page.order?.lineItems)
    }
    return toOrder(raw, lines)
  }
}

interface RawConnection<T> {
  readonly nodes?: T[]
  readonly pageInfo?: { readonly hasNextPage?: boolean; readonly endCursor?: string | null }
}

interface RawShop {
  readonly id?: string
  readonly name?: string
  readonly myshopifyDomain?: string
  readonly ianaTimezone?: string | null
  readonly currencyCode?: string | null
  readonly shopAddress?: { readonly countryCodeV2?: string | null } | null
  readonly primaryDomain?: {
    readonly host?: string | null
    readonly localization?: { readonly defaultLocale?: string | null } | null
  } | null
}

interface RawVariant {
  readonly legacyResourceId?: string
  readonly title?: string | null
  readonly sku?: string | null
  readonly price?: string | null
  readonly compareAtPrice?: string | null
  readonly availableForSale?: boolean
}

interface RawMetafield {
  readonly namespace?: string | null
  readonly key?: string | null
  readonly value?: string | null
  readonly type?: string | null
}

interface RawProduct {
  readonly legacyResourceId?: string
  readonly title?: string
  readonly descriptionHtml?: string | null
  readonly handle?: string
  readonly productType?: string | null
  readonly vendor?: string | null
  readonly tags?: string[]
  readonly status?: string
  readonly updatedAt?: string
  readonly options?: { readonly name?: string; readonly position?: number; readonly values?: string[] }[]
  readonly variants?: RawConnection<RawVariant>
  readonly media?: { readonly nodes?: { readonly image?: { readonly url?: string; readonly altText?: string | null } | null }[] }
  readonly metafields?: RawConnection<RawMetafield>
}

interface RawLineItem {
  readonly title?: string | null
  readonly quantity?: number
  readonly currentQuantity?: number
  readonly isGiftCard?: boolean
  readonly product?: { readonly legacyResourceId?: string } | null
  readonly discountedUnitPriceAfterAllDiscountsSet?: { readonly shopMoney?: { readonly amount?: string } } | null
}

interface RawOrder {
  readonly legacyResourceId?: string
  readonly createdAt?: string
  readonly currencyCode?: string | null
  readonly test?: boolean
  readonly cancelledAt?: string | null
  readonly customerJourneySummary?: { readonly lastVisit?: { readonly landingPage?: string | null } | null } | null
  readonly lineItems?: RawConnection<RawLineItem>
}

interface RawContent {
  readonly id?: string
  readonly legacyResourceId?: string
  readonly handle?: string
  readonly title?: string
  readonly descriptionHtml?: string | null
  readonly body?: string | null
  readonly updatedAt?: string
  readonly isPublished?: boolean
  readonly status?: string
  readonly seo?: { readonly title?: string | null; readonly description?: string | null } | null
  readonly blog?: { readonly handle?: string | null } | null
  readonly metafields?: { readonly nodes?: { readonly key?: string; readonly value?: string | null }[] }
}

function toProduct(
  raw: RawProduct,
  variants: readonly RawVariant[],
  metafields: readonly RawMetafield[],
): ShopifyProduct {
  return {
    id: String(raw.legacyResourceId ?? ''),
    title: raw.title ?? '',
    body_html: raw.descriptionHtml ?? null,
    handle: raw.handle ?? '',
    product_type: raw.productType ?? null,
    vendor: raw.vendor ?? null,
    // Our own shape keeps Shopify's older one comma-joined, so one product
    // reader serves both what a webhook delivers and what a query answers.
    tags: (raw.tags ?? []).join(','),
    status: raw.status ? raw.status.toLowerCase() : null,
    updated_at: raw.updatedAt ?? null,
    options: (raw.options ?? []).map((option) => ({
      name: option.name ?? null,
      position: option.position ?? null,
      values: option.values ?? [],
    })),
    variants: variants.map((variant) => ({
      id: String(variant.legacyResourceId ?? ''),
      title: variant.title ?? null,
      sku: variant.sku ?? null,
      price: variant.price ?? null,
      compare_at_price: variant.compareAtPrice ?? null,
      // Shopify's own answer to "would the store sell one right now", which
      // already accounts for stock it does not track and for stores that keep
      // selling when they run out.
      available: variant.availableForSale ?? null,
    })),
    images: (raw.media?.nodes ?? [])
      .map((node) => ({ src: node.image?.url ?? null, alt: node.image?.altText ?? null }))
      .filter((image) => image.src !== null),
    metafields: metafields.map(
      (field): ShopifyMetafield => ({
        namespace: field.namespace ?? null,
        key: field.key ?? null,
        value: field.value ?? null,
        type: field.type ?? null,
      }),
    ),
  }
}

function toOrder(raw: RawOrder, lines: readonly RawLineItem[]): ShopifyOrder {
  return {
    id: String(raw.legacyResourceId ?? ''),
    createdAt: raw.createdAt ?? null,
    currency: raw.currencyCode ?? null,
    landingPage: raw.customerJourneySummary?.lastVisit?.landingPage ?? null,
    cancelledAt: raw.cancelledAt ?? null,
    test: raw.test ?? false,
    lineItems: lines.map((line) => ({
      productId: line.product?.legacyResourceId ? String(line.product.legacyResourceId) : null,
      title: line.title ?? '',
      // What is still owned after refunds and removals, priced after every
      // discount: the two together are what the store actually earned.
      quantity: line.currentQuantity ?? line.quantity ?? 0,
      unitPrice: line.discountedUnitPriceAfterAllDiscountsSet?.shopMoney?.amount ?? null,
      isGiftCard: line.isGiftCard ?? false,
    })),
  }
}

function toContentRecord(raw: RawContent, kind: StoreContentKind): StoreContentRecord {
  const seo = raw.seo ?? seoFromMetafields(raw)
  const shopifyId = raw.legacyResourceId ? String(raw.legacyResourceId) : legacyIdOf(raw.id)
  return {
    kind,
    shopifyId,
    handle: raw.handle ?? shopifyId,
    title: raw.title ?? '',
    bodyHtml: raw.descriptionHtml ?? raw.body ?? null,
    seoTitle: nonEmpty(seo?.title),
    seoDescription: nonEmpty(seo?.description),
    ...(raw.updatedAt ? { updatedAt: raw.updatedAt } : {}),
    ...(raw.blog?.handle ? { blogHandle: raw.blog.handle } : {}),
  }
}

/** Pages and posts keep their search title and description as metafields rather than in a field of their own. */
function seoFromMetafields(raw: RawContent): { title: string | null; description: string | null } {
  const nodes = raw.metafields?.nodes ?? []
  const valueOf = (key: string) => nodes.find((node) => node.key === key)?.value ?? null
  return { title: valueOf('title_tag'), description: valueOf('description_tag') }
}

function cursorOf(connection: RawConnection<unknown> | undefined | null): string | undefined {
  if (!connection?.pageInfo?.hasNextPage) return undefined
  return connection.pageInfo.endCursor ?? undefined
}

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}
