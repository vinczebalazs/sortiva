import { gzipSync, gunzipSync } from 'node:zlib'
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import type { Db } from '../client'
import { products, shopifyConns, storePages } from '../schema'
import type { AccountScope, SystemScope } from '../scope'

export type StorePageRow = typeof storePages.$inferSelect

/**
 * The store's own pages, as we hold them.
 *
 * One row per address, and the address is the identity: a unique index on
 * `(account_id, url)` is what makes re-reading the same store converge on the
 * same rows instead of accumulating copies of them.
 */

export interface StorePageInput {
  readonly url: string
  readonly pageType: 'collection' | 'product' | 'page' | 'blog_article' | 'article_ours' | 'other'
  readonly handle: string
  readonly shopifyId: string
  readonly title: string
  readonly seoTitle: string | null
  readonly seoDescription: string | null
  readonly headings: readonly string[]
  readonly bodyHtml: string | null
  readonly outboundInternalLinks: readonly string[]
  readonly familyIds: readonly string[]
  readonly checksum: string
}

/** What we already hold for these addresses, so an unchanged page is not rewritten. */
export async function storePageChecksums(
  db: Db,
  scope: AccountScope,
  urls: readonly string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>()
  if (urls.length === 0) return out
  const rows = await db
    .select({ url: storePages.url, checksum: storePages.checksum })
    .from(storePages)
    .where(and(eq(storePages.accountId, scope.accountId), inArray(storePages.url, [...urls])))
  for (const row of rows) out.set(row.url, row.checksum)
  return out
}

/**
 * Writes a batch of pages, replacing what we held for the same addresses.
 *
 * Two things are deliberately *not* overwritten. A row already marked as one of
 * our own published articles keeps that marking: the store hands our article
 * back as an ordinary blog post, and letting the nightly read demote it would
 * lose the only thing distinguishing content we wrote from content the merchant
 * wrote. And `article_id`, which points at that article, is left alone for the
 * same reason.
 */
export async function upsertStorePages(
  db: Db,
  scope: AccountScope,
  pages: readonly StorePageInput[],
  now: Date = new Date(),
): Promise<number> {
  if (pages.length === 0) return 0
  const values = pages.map((page) => ({
    accountId: scope.accountId,
    url: page.url,
    pageType: page.pageType,
    handle: page.handle,
    shopifyId: page.shopifyId,
    title: page.title,
    seoTitle: page.seoTitle,
    seoDescription: page.seoDescription,
    headingsJson: [...page.headings],
    bodyCompressed: compressBody(page.bodyHtml),
    outboundInternalLinks: [...page.outboundInternalLinks],
    familyIds: [...page.familyIds],
    checksum: page.checksum,
    lastSyncedAt: now,
  }))

  await db
    .insert(storePages)
    .values(values)
    .onConflictDoUpdate({
      target: [storePages.accountId, storePages.url],
      set: {
        pageType: sql`case when ${storePages.pageType} = 'article_ours' then ${storePages.pageType} else excluded.page_type end`,
        handle: sql`excluded.handle`,
        shopifyId: sql`excluded.shopify_id`,
        title: sql`excluded.title`,
        seoTitle: sql`excluded.seo_title`,
        seoDescription: sql`excluded.seo_description`,
        headingsJson: sql`excluded.headings_json`,
        bodyCompressed: sql`excluded.body_compressed`,
        outboundInternalLinks: sql`excluded.outbound_internal_links`,
        familyIds: sql`excluded.family_ids`,
        checksum: sql`excluded.checksum`,
        lastSyncedAt: sql`excluded.last_synced_at`,
      },
    })
  return values.length
}

export async function listStorePages(
  db: Db,
  scope: AccountScope,
): Promise<StorePageRow[]> {
  return db
    .select()
    .from(storePages)
    .where(eq(storePages.accountId, scope.accountId))
    .orderBy(storePages.url)
}

/** The page's body as it was published. Stored compressed; read back as text. */
export function readStorePageBody(row: Pick<StorePageRow, 'bodyCompressed'>): string | null {
  if (!row.bodyCompressed) return null
  return gunzipSync(row.bodyCompressed).toString('utf8')
}

/**
 * Which family each of these products belongs to.
 *
 * Keyed by Shopify's own product id rather than ours, because the inventory
 * knows a collection's members by the ids the store gave it and has no other
 * way to reach our rows.
 */
export async function familyIdsByShopifyProductId(
  db: Db,
  scope: AccountScope,
  shopifyProductIds: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (shopifyProductIds.length === 0) return out
  const rows = await db
    .select({ shopifyProductId: products.shopifyProductId, familyId: products.familyId })
    .from(products)
    .where(
      and(
        eq(products.accountId, scope.accountId),
        inArray(products.shopifyProductId, [...shopifyProductIds]),
        isNotNull(products.familyId),
      ),
    )
  for (const row of rows) if (row.familyId) out.set(row.shopifyProductId, row.familyId)
  return out
}

/**
 * Every store whose connection is still good.
 *
 * Crosses accounts by design — the nightly sweep is what decides who to work
 * for — so it takes a system scope, and each store's own work then happens under
 * its own.
 */
export async function accountsWithLiveShopifyConnection(
  db: Db,
  _scope: SystemScope,
): Promise<string[]> {
  const rows = await db
    .select({ accountId: shopifyConns.accountId })
    .from(shopifyConns)
    .where(sql`${shopifyConns.invalidatedAt} is null`)
  return rows.map((row) => row.accountId)
}

/**
 * Gzip rather than raw text. Page bodies are the bulkiest thing we keep per
 * store and they are read rarely — by the evidence pack for a page we are about
 * to recommend changes to — so paying to decompress on the way out is the right
 * side of the trade.
 */
function compressBody(bodyHtml: string | null): Buffer | null {
  if (bodyHtml === null) return null
  return gzipSync(Buffer.from(bodyHtml, 'utf8'))
}
