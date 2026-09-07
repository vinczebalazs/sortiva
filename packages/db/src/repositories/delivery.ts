import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '../client'
import { articleProductRefs, articles, products, storePages } from '../schema'
import type { AccountScope } from '../scope'
import type { ArticleRow } from './articles'
import {
  completeOpportunityForPublishedArticle,
  type ArticlePublication,
} from './opportunity-completion'

/**
 * Everything the publish hour and the export bundle read and write.
 *
 * It is a file of its own rather than more of `articles.ts` for a merge reason
 * as much as a shape one: three lanes have been appending to that file, and a
 * new file cannot conflict with any of them.
 *
 * Two rules run through all of it. Delivery is a guarded transition, so a
 * second sweep or a redelivered job moves nothing. And the values an export
 * bundle shows — a price, a title, an address — are read from the store's
 * current rows at the moment the bundle is built, never from what was written
 * down when the article was drafted; that is why the product read here has no
 * "as at" parameter to pass it a stale moment with.
 */

/**
 * The article goes out.
 *
 * Guarded to `draft`, which after `T4.5`'s landing rules is where every article
 * cleared for delivery sits — one that passed the quality bar, one the merchant
 * approved, one they published over a rejection. A zero-row result means
 * somebody else already delivered it, or it was discarded in between, and the
 * caller must stop rather than retry.
 *
 * For an export account this is not a write to anybody's shop: it is the moment
 * the finished article becomes downloadable in the app. Nothing here touches
 * Shopify.
 *
 * It also closes the suggestion the article came from, in the same transaction.
 * That belongs here rather than at the call site because this and
 * `markArticleAutoPublished` are the only two places in the product where an
 * article becomes published: a completion attached to whichever call site was
 * in front of us would leave every other publishing path with the original
 * defect, and a completion in a second transaction would leave a window in
 * which the article is out and the suggestion still says it is not.
 */
export async function markArticleDelivered(
  db: Db,
  scope: AccountScope,
  articleId: string,
  delivery: ArticleRow['delivery'],
  now: Date = new Date(),
): Promise<ArticlePublication | undefined> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(articles)
      .set({ state: 'published', delivery, publishedAt: now, updatedAt: now })
      .where(
        and(
          eq(articles.accountId, scope.accountId),
          eq(articles.id, articleId),
          eq(articles.state, 'draft'),
        ),
      )
      .returning()
    if (!row) return undefined
    return {
      article: row,
      completedOpportunity: await completeOpportunityForPublishedArticle(tx, scope, articleId, now),
    }
  })
}

/**
 * Where the merchant published a downloaded article.
 *
 * Search performance is attributed by address, so this is the one field in the
 * product where a wrong answer credits this store with somebody else's traffic.
 * Whether the address is on their own site is decided before this is called
 * (`packages/core/src/publish/published-url.ts`); this stores what it is given.
 *
 * Guarded to a published export article: there is nothing to confirm about a
 * draft, and an auto-published article already knows its own address.
 */
export async function setPublishedUrlGuarded(
  db: Db,
  scope: AccountScope,
  articleId: string,
  url: string,
  now: Date = new Date(),
): Promise<ArticleRow | undefined> {
  const [row] = await db
    .update(articles)
    .set({ publishedUrl: url, updatedAt: now })
    .where(
      and(
        eq(articles.accountId, scope.accountId),
        eq(articles.id, articleId),
        eq(articles.state, 'published'),
        eq(articles.delivery, 'export'),
      ),
    )
    .returning()
  return row
}

/** A product as the store sells it *now* — the only version an export bundle is allowed to show. */
export interface LiveProductRow {
  readonly id: string
  readonly shopifyProductId: string
  readonly title: string
  readonly priceRange: { readonly min: number; readonly max: number; readonly currency?: string } | null
  readonly variants: readonly {
    readonly price: number | null
    readonly available: boolean
    readonly compareAtPrice: number | null
  }[]
}

/**
 * The current rows for the products an article names.
 *
 * Deliberately reads the catalogue rather than `article_product_refs.resolved_values_json`:
 * the stored values are the last resolution, kept for display between builds
 * and for the drift sweep to compare against, and reading them back would be
 * the stale price the whole placeholder mechanism exists to prevent.
 *
 * `raw_body_html` is not selected. It is quarantined, and nothing an export
 * bundle shows comes from it.
 */
export async function liveProductsByIds(
  db: Db,
  scope: AccountScope,
  productIds: readonly string[],
): Promise<readonly LiveProductRow[]> {
  if (productIds.length === 0) return []
  const rows = await db
    .select({
      id: products.id,
      shopifyProductId: products.shopifyProductId,
      title: products.title,
      priceRange: products.priceRange,
      variants: products.variants,
    })
    .from(products)
    .where(and(eq(products.accountId, scope.accountId), inArray(products.id, [...productIds])))
  return rows.map((row) => ({
    id: row.id,
    shopifyProductId: row.shopifyProductId,
    title: row.title,
    priceRange: (row.priceRange ?? null) as LiveProductRow['priceRange'],
    variants: (row.variants ?? []) as LiveProductRow['variants'],
  }))
}

/**
 * The address each of these products is sold at, from the store's own content
 * inventory.
 *
 * The inventory is where a product URL lives: the catalogue tables keep what a
 * product *is*, and the inventory keeps every page the shop serves. A product
 * with no inventory row yet (the walk has not reached it) simply has no
 * address, and the bundle renders its title without a link rather than
 * inventing one.
 */
export async function productPageUrlsByShopifyId(
  db: Db,
  scope: AccountScope,
  shopifyProductIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (shopifyProductIds.length === 0) return new Map()
  const rows = await db
    .select({ shopifyId: storePages.shopifyId, url: storePages.url })
    .from(storePages)
    .where(
      and(
        eq(storePages.accountId, scope.accountId),
        eq(storePages.pageType, 'product'),
        inArray(storePages.shopifyId, [...shopifyProductIds]),
      ),
    )
  const urls = new Map<string, string>()
  for (const row of rows) if (row.shopifyId) urls.set(row.shopifyId, row.url)
  return urls
}

/**
 * What the reader was last shown for one product reference.
 *
 * Written on every bundle build so that between builds the app can show the
 * same figures the merchant downloaded, and so the drift sweep has something
 * to compare the store against. It is a record of the last resolution, never an
 * input to the next one.
 */
export async function recordResolvedRefValues(
  db: Db,
  scope: AccountScope,
  articleId: string,
  resolved: ReadonlyMap<string, Record<string, string>>,
  now: Date = new Date(),
): Promise<number> {
  if (resolved.size === 0) return 0
  // Scoped by the article's own account before anything is written: the refs
  // table carries no account column of its own, so this join is what stops one
  // account's write reaching another's rows.
  const [owned] = await db
    .select({ id: articles.id })
    .from(articles)
    .where(and(eq(articles.accountId, scope.accountId), eq(articles.id, articleId)))
    .limit(1)
  if (!owned) return 0

  let written = 0
  for (const [placeholderKey, values] of resolved) {
    const rows = await db
      .update(articleProductRefs)
      .set({ resolvedValuesJson: values as never, resolvedAt: now })
      .where(
        and(
          eq(articleProductRefs.articleId, articleId),
          eq(articleProductRefs.placeholderKey, placeholderKey),
        ),
      )
      .returning({ id: articleProductRefs.id })
    written += rows.length
  }
  return written
}
