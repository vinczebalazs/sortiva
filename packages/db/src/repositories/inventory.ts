import { gzipSync, gunzipSync } from 'node:zlib'
import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import type { Db } from '../client'
import { articles, products, shopifyConns, storePages } from '../schema'
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

/**
 * Records that the store served these addresses at `at`.
 *
 * This is the only thing that distinguishes "we looked and it was there" from
 * "nothing about it changed": `upsertStorePages` runs only for pages whose
 * content moved, so an unchanged page's `last_synced_at` would otherwise sit
 * still while the page is served every day.
 *
 * Serving a page is also what makes it live again, so a row that had been
 * marked gone comes back here. It cannot come back through the upsert: a
 * restored page has the checksum it always had, so nothing would write it.
 */
export async function markStorePagesSeen(
  db: Db,
  scope: AccountScope,
  urls: readonly string[],
  at: Date,
): Promise<void> {
  if (urls.length === 0) return
  await db
    .update(storePages)
    .set({ lastSyncedAt: at, status: 'live' })
    .where(and(eq(storePages.accountId, scope.accountId), inArray(storePages.url, [...urls])))
}

/**
 * Records that these addresses hold articles we published, and which article
 * each one is.
 *
 * A write of its own rather than part of the page write, for the same reason
 * "we saw it" is: `upsertStorePages` runs only for pages whose words moved, and
 * one of our own articles sitting untouched on a merchant's blog never moves.
 * A merchant who tells us weeks later where they published a downloaded article
 * would otherwise never have that row recognised at all.
 *
 * It does not touch the checksum, so being recognised is not an edit and does
 * not re-run the paid analyses that hang off one.
 */
export async function markStorePagesOurs(
  db: Db,
  scope: AccountScope,
  pages: readonly { readonly url: string; readonly articleId: string }[],
): Promise<number> {
  if (pages.length === 0) return 0
  const urls = pages.map((page) => page.url)
  // One statement rather than one per article: a store that has been with us
  // for a year has hundreds of these, and a walk batch can hold any number of
  // them.
  const branches = sql.join(
    pages.map((page) => sql`when ${storePages.url} = ${page.url} then ${page.articleId}::uuid`),
    sql` `,
  )
  const marked = await db
    .update(storePages)
    .set({
      pageType: 'article_ours',
      articleId: sql`case ${branches} end`,
    })
    .where(and(eq(storePages.accountId, scope.accountId), inArray(storePages.url, urls)))
    .returning({ id: storePages.id })
  return marked.length
}

/**
 * Every article we published for this store, with the address it went to.
 *
 * The walk compares this against the addresses the store served it, which is
 * the only way it can tell an article we wrote from one the merchant wrote:
 * the store hands ours back as an ordinary blog post with nothing on it that
 * says whose it is.
 *
 * Oldest first, so that if two articles somehow claim one address the walk
 * settles on the same one every night rather than alternating.
 */
export async function publishedArticleAddresses(
  db: Db,
  scope: AccountScope,
): Promise<readonly { readonly articleId: string; readonly url: string }[]> {
  const rows = await db
    .select({ articleId: articles.id, url: articles.publishedUrl })
    .from(articles)
    .where(
      and(
        eq(articles.accountId, scope.accountId),
        eq(articles.state, 'published'),
        isNotNull(articles.publishedUrl),
      ),
    )
    .orderBy(asc(articles.publishedAt))
  return rows.flatMap((row) => (row.url ? [{ articleId: row.articleId, url: row.url }] : []))
}

/**
 * Marks the pages a completed walk did not find as gone, and answers how many.
 *
 * `since` must be the moment a walk that reached the end of the store began —
 * anything else and this marks pages the walk simply had not got to yet. The
 * caller owns that guarantee; there is nothing in a timestamp that can check it.
 *
 * Two exclusions. Rows already gone are skipped, which is what lets the nightly
 * walk run this every night without re-marking or miscounting. And our own
 * published articles are never marked gone: they are our record of what we
 * delivered, and a store on export delivery has them nowhere the walk can see,
 * so absence from the store is not evidence that they went anywhere.
 */
export async function markStorePagesGoneNotSeenSince(
  db: Db,
  scope: AccountScope,
  since: Date,
): Promise<number> {
  const marked = await db
    .update(storePages)
    .set({ status: 'gone' })
    .where(
      and(
        eq(storePages.accountId, scope.accountId),
        eq(storePages.status, 'live'),
        sql`${storePages.pageType} <> 'article_ours'`,
        sql`${storePages.lastSyncedAt} < ${since}`,
      ),
    )
    .returning({ id: storePages.id })
  return marked.length
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

/**
 * The pages the store still serves.
 *
 * What almost every reader wants. `listStorePages` returns deleted pages too,
 * which is right for erasing an account and wrong for anything that asks what
 * the store covers: a page the merchant took down cannot be improved, cannot be
 * compared against a competitor, and must not go on counting as coverage that
 * stops us proposing a replacement.
 *
 * A deleted row is kept rather than removed, because the walk can find the page
 * again and put it straight back to live — so this filters rather than the
 * inventory forgetting.
 */
export async function listLiveStorePages(db: Db, scope: AccountScope): Promise<StorePageRow[]> {
  return db
    .select()
    .from(storePages)
    .where(and(eq(storePages.accountId, scope.accountId), eq(storePages.status, 'live')))
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
