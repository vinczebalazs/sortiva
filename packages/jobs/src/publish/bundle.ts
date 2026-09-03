import {
  buildExportBundle,
  type ArticleBody,
  type BundleImage,
  type ExportBundle,
  type LiveProduct,
  type ProductReference,
} from '@sortiva/core'
import {
  accountScope,
  findArticleById,
  findArticleProductRefs,
  liveProductsByIds,
  productPageUrlsByShopifyId,
  recordResolvedRefValues,
  type Db,
  type LiveProductRow,
} from '@sortiva/db'

/**
 * Building the download a merchant on export mode asks for.
 *
 * The whole point of this file is *when* it reads: every price, every stock
 * state, every product address comes out of the store's own current rows at the
 * moment the merchant clicks download — never from anything recorded when the
 * article was written. An article drafted three weeks ago and downloaded today
 * carries today's prices.
 *
 * The shaping (Markdown, HTML, the metadata block, dropping any image address
 * that is not on the shop's own CDN) is `packages/core/src/publish`; this is
 * the reading and the recording around it.
 */

export interface BundleDeps {
  readonly db: Db
  readonly now?: () => Date
}

export interface BundleRequest {
  readonly accountId: string
  readonly articleId: string
}

/** The article is not this account's, or does not exist. */
export class ArticleNotFound extends Error {
  readonly retryable = false
  readonly errorClass = 'article_not_found'

  constructor(articleId: string) {
    super(`no article ${articleId} on this account`)
    this.name = 'ArticleNotFound'
  }
}

/** The writer has not finished: there is a row, but no body to hand over. */
export class ArticleHasNoBody extends Error {
  readonly retryable = false
  readonly errorClass = 'article_has_no_body'

  constructor(articleId: string) {
    super(`article ${articleId} has no stored draft yet`)
    this.name = 'ArticleHasNoBody'
  }
}

/**
 * The lowest price the store currently asks for a product.
 *
 * The stored price range is the cheap answer and the variants are the
 * authoritative one, because a range is recomputed only when the whole product
 * is written back. Where they disagree the variants win.
 */
function currentPrice(row: LiveProductRow): { price: number | null; compareAtPrice: number | null } {
  const prices = row.variants.map((v) => v.price).filter((p): p is number => p !== null)
  const price = prices.length > 0 ? Math.min(...prices) : (row.priceRange?.min ?? null)
  const cheapest = row.variants.find((v) => v.price !== null && v.price === price)
  return { price, compareAtPrice: cheapest?.compareAtPrice ?? null }
}

export async function buildBundleForArticle(
  deps: BundleDeps,
  request: BundleRequest,
): Promise<ExportBundle> {
  const now = (deps.now ?? (() => new Date()))()
  const scope = accountScope(request.accountId)

  const article = await findArticleById(deps.db, scope, request.articleId)
  if (!article) throw new ArticleNotFound(request.articleId)
  if (!article.bodyJson) throw new ArticleHasNoBody(request.articleId)

  const refRows = await findArticleProductRefs(deps.db, scope, request.articleId)
  const references: ProductReference[] = refRows.map((row) => ({
    placeholderKey: row.placeholderKey,
    productId: row.productId,
    refType: row.refType,
    fieldsRendered: row.fieldsRendered,
  }))

  const productIds = references.flatMap((reference) => (reference.productId ? [reference.productId] : []))
  const rows = await liveProductsByIds(deps.db, scope, productIds)
  const urls = await productPageUrlsByShopifyId(
    deps.db,
    scope,
    rows.map((row) => row.shopifyProductId),
  )

  const live = new Map<string, LiveProduct>()
  for (const row of rows) {
    const { price, compareAtPrice } = currentPrice(row)
    live.set(row.id, {
      productId: row.id,
      title: row.title,
      price,
      compareAtPrice,
      available: row.variants.length === 0 || row.variants.some((v) => v.available),
      currency: row.priceRange?.currency ?? null,
      url: urls.get(row.shopifyProductId) ?? null,
    })
  }

  const bundle = buildExportBundle({
    article: {
      title: article.title,
      slug: article.slug,
      metaDescription: article.metaDescription ?? '',
      targetKeyword: article.targetKeyword,
      body: article.bodyJson as ArticleBody,
    },
    references,
    live,
    // Empty in the running product, and correctly so rather than as a
    // placeholder: nothing in the schema holds a Shopify image address. The
    // catalogue sync reads them and drops them, so there is nowhere to read
    // one back from. See DECISIONS 2026-09-04 T5.1.
    images: [] as readonly BundleImage[],
  })

  // What the merchant was just handed, kept so the app can show the same
  // figures between downloads and so the drift sweep has something to compare
  // the store against. Never read back as an input to the next build.
  await recordResolvedRefValues(
    deps.db,
    scope,
    request.articleId,
    new Map([...bundle.resolved].map(([key, reference]) => [key, { ...reference.values }])),
    now,
  )

  return bundle
}
