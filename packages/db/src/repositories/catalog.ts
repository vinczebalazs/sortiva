import { gzipSync, gunzipSync } from 'node:zlib'
import { and, asc, eq, gt, inArray, isNull, lt, notInArray, sql } from 'drizzle-orm'
import {
  descriptionText,
  type FactSheet,
  type ProductMetafield,
  type ProductOption,
} from '@sortiva/core'
import type { Db } from '../client'
import {
  landingRevenueDaily,
  productFacts,
  products,
  shopifyConns,
  topProducts,
} from '../schema'
import type { AccountScope, SystemScope } from '../scope'

export type ProductRecord = typeof products.$inferSelect

/**
 * A store's catalogue as we hold it: one row per product, the best sellers we
 * computed from its orders, and the daily takings per landing page.
 *
 * Two of these three tables have no column a shopper's name, address or email
 * could go in. That is not an oversight to be corrected later — it is what makes
 * "we hold no customer data" a fact about the schema rather than a promise about
 * our conduct, and `no-customer-data.test.ts` fails if a column that could hold
 * one ever appears.
 */

/** One product, ready to be written. Mirrors `ProductRow` in `packages/core`. */
export interface ProductInput {
  readonly shopifyProductId: string
  readonly title: string
  readonly rawBodyHtml: string | null
  readonly productType: string | null
  readonly tags: readonly string[]
  readonly variants: unknown
  readonly priceRange: unknown
  /**
   * The store's own option axes. `undefined` means this caller did not read
   * them and the stored value is to be left alone; an empty list means the
   * store states none, which is a fact and is written.
   */
  readonly options?: unknown
  /** The store's own metafields, on the same undefined-means-unread rule. */
  readonly metafields?: unknown
  /** The product's pictures, on the same rule: a read that did not ask for them leaves them alone. */
  readonly images?: unknown
  readonly updatedAt: Date | null
  readonly checksum: string
}

/**
 * Writes a batch of products, replacing what we held for the same Shopify ids.
 *
 * The unique index on `(account_id, shopify_product_id)` is what makes
 * re-reading a store converge on the same rows rather than accumulating copies:
 * a sync that ran twice, or resumed after a crash and re-read a page, lands on
 * the rows it already wrote.
 *
 * `family_id` and `logical_product_id` are deliberately left alone on conflict.
 * They are decided by the grouping step, not by Shopify, and a nightly re-read
 * that cleared them would un-group the catalogue every night.
 *
 * Options and metafields are left alone too, but for a different reason and only
 * when the caller did not read them. They cost an extra request or an extra
 * field to fetch, so not every path that writes a product has them in hand — a
 * webhook delivery carries options but never metafields. A caller that did not
 * ask must not be able to erase what a caller that did asked for, so the batch
 * is split by which of the two it actually holds and each group is written with
 * its own conflict clause.
 */
export async function upsertProducts(
  db: Db,
  scope: AccountScope,
  batch: readonly ProductInput[],
  now: Date = new Date(),
): Promise<number> {
  if (batch.length === 0) return 0

  const groups = new Map<string, ProductInput[]>()
  for (const product of batch) {
    const key =
      `${product.options === undefined ? '-' : 'o'}` +
      `${product.metafields === undefined ? '-' : 'm'}` +
      `${product.images === undefined ? '-' : 'i'}`
    const bucket = groups.get(key) ?? []
    bucket.push(product)
    groups.set(key, bucket)
  }

  for (const bucket of groups.values()) {
    const hasOptions = bucket[0]!.options !== undefined
    const hasMetafields = bucket[0]!.metafields !== undefined
    const hasImages = bucket[0]!.images !== undefined

    const values = bucket.map((product) => ({
      accountId: scope.accountId,
      shopifyProductId: product.shopifyProductId,
      title: product.title,
      // Bulky, rarely read, and quarantined from everything downstream — so it is
      // stored compressed rather than as text.
      rawBodyHtml: compressBody(product.rawBodyHtml),
      productType: product.productType,
      tags: [...product.tags],
      variants: product.variants as never,
      priceRange: product.priceRange as never,
      ...(hasOptions ? { options: product.options as never } : {}),
      ...(hasMetafields ? { metafields: product.metafields as never } : {}),
      ...(hasImages ? { images: product.images as never } : {}),
      updatedAt: product.updatedAt,
      checksum: product.checksum,
      syncedAt: now,
    }))

    await db
      .insert(products)
      .values(values)
      .onConflictDoUpdate({
        target: [products.accountId, products.shopifyProductId],
        set: {
          title: sql`excluded.title`,
          rawBodyHtml: sql`excluded.raw_body_html`,
          productType: sql`excluded.product_type`,
          tags: sql`excluded.tags`,
          variants: sql`excluded.variants`,
          priceRange: sql`excluded.price_range`,
          ...(hasOptions ? { options: sql`excluded.options` } : {}),
          ...(hasMetafields ? { metafields: sql`excluded.metafields` } : {}),
          ...(hasImages ? { images: sql`excluded.images` } : {}),
          updatedAt: sql`excluded.updated_at`,
          checksum: sql`excluded.checksum`,
          syncedAt: sql`excluded.synced_at`,
        },
      })
  }
  return batch.length
}

/** What we already hold for a product, as the change comparison needs it. */
export interface StoredProductRecord {
  readonly id: string
  readonly checksum: string | null
  readonly updatedAt: Date | null
  readonly variants: unknown
}

/**
 * The whole catalogue's fingerprints, keyed by Shopify's id.
 *
 * Read in one query rather than per product: the nightly sweep compares every
 * product in the store, and a query per product would be a thousand round trips
 * against a table we could have read once.
 */
export async function storedProductStates(
  db: Db,
  scope: AccountScope,
): Promise<Map<string, StoredProductRecord>> {
  const rows = await db
    .select({
      id: products.id,
      shopifyProductId: products.shopifyProductId,
      checksum: products.checksum,
      updatedAt: products.updatedAt,
      variants: products.variants,
    })
    .from(products)
    .where(eq(products.accountId, scope.accountId))

  const out = new Map<string, StoredProductRecord>()
  for (const row of rows) {
    out.set(row.shopifyProductId, {
      id: row.id,
      checksum: row.checksum,
      updatedAt: row.updatedAt,
      variants: row.variants,
    })
  }
  return out
}

/** One product's fingerprint, for the single-product path a webhook takes. */
export async function storedProductState(
  db: Db,
  scope: AccountScope,
  shopifyProductId: string,
): Promise<StoredProductRecord | undefined> {
  const [row] = await db
    .select({
      id: products.id,
      checksum: products.checksum,
      updatedAt: products.updatedAt,
      variants: products.variants,
    })
    .from(products)
    .where(
      and(
        eq(products.accountId, scope.accountId),
        eq(products.shopifyProductId, shopifyProductId),
      ),
    )
    .limit(1)
  return row
}

/** Our own row ids for a set of Shopify product ids, which the best-seller table keys on. */
export async function productIdsByShopifyId(
  db: Db,
  scope: AccountScope,
  shopifyProductIds: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (shopifyProductIds.length === 0) return out
  const rows = await db
    .select({ id: products.id, shopifyProductId: products.shopifyProductId })
    .from(products)
    .where(
      and(
        eq(products.accountId, scope.accountId),
        inArray(products.shopifyProductId, [...shopifyProductIds]),
      ),
    )
  for (const row of rows) out.set(row.shopifyProductId, row.id)
  return out
}

/** One row of the Products screen's table: what we hold about a product, and how much of it there is. */
export interface CatalogProductRow {
  /** Our own row id, the same id the family list and the best-seller list are keyed on. */
  readonly id: string
  readonly title: string
  readonly familyId: string | null
  /** Shopify's own id, which the merchant's admin address is built from. */
  readonly shopifyProductId: string
  /** Null when nothing has been distilled from this product yet — not the same as a product with nothing to say. */
  readonly factSheet: FactSheet | null
  readonly factCount: number
  readonly syncedAt: Date
}

/**
 * Every product in one store, with its fact sheet where one exists.
 *
 * A left join rather than an inner one: a product queued for distillation, or
 * one whose description defeated it, still belongs on the merchant's own
 * catalogue screen — dropping it would quietly shorten a store's product count
 * to the products we happened to have read.
 *
 * `raw_body_html` is not among the selected columns and must not become one.
 * The quarantined description leaves this table only for display and debugging,
 * never towards a response.
 */
export async function listCatalogProducts(
  db: Db,
  scope: AccountScope,
): Promise<CatalogProductRow[]> {
  const rows = await db
    .select({
      id: products.id,
      title: products.title,
      familyId: products.familyId,
      shopifyProductId: products.shopifyProductId,
      factsJson: productFacts.factsJson,
      factCount: productFacts.factCount,
      syncedAt: products.syncedAt,
    })
    .from(products)
    .leftJoin(productFacts, eq(productFacts.productId, products.id))
    .where(eq(products.accountId, scope.accountId))
    .orderBy(asc(products.title), asc(products.id))

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    familyId: row.familyId,
    shopifyProductId: row.shopifyProductId,
    factSheet: row.factsJson === null ? null : (row.factsJson as FactSheet),
    factCount: row.factCount ?? 0,
    syncedAt: row.syncedAt,
  }))
}

/** One best seller, ready to be written. */
export interface TopProductInput {
  /** Our own product row id. */
  readonly productId: string
  readonly title: string
  readonly url: string | null
  readonly revenue90d: number
  readonly qty90d: number
  readonly rank: number
}

/**
 * Replaces the store's best-seller list.
 *
 * A replacement rather than a merge: the list is the answer to one question
 * asked over one window, and a product that stopped selling has to leave it.
 * Deleting what is no longer ranked and upserting the rest keeps the operation
 * idempotent — running the same computation twice leaves the same ten rows.
 */
export async function replaceTopProducts(
  db: Db,
  scope: AccountScope,
  ranked: readonly TopProductInput[],
  now: Date = new Date(),
): Promise<number> {
  const keep = ranked.map((entry) => entry.productId)
  await db
    .delete(topProducts)
    .where(
      keep.length === 0
        ? eq(topProducts.accountId, scope.accountId)
        : and(eq(topProducts.accountId, scope.accountId), notInArray(topProducts.productId, keep)),
    )

  if (ranked.length === 0) return 0
  await db
    .insert(topProducts)
    .values(
      ranked.map((entry) => ({
        accountId: scope.accountId,
        productId: entry.productId,
        title: entry.title,
        url: entry.url,
        revenue90d: entry.revenue90d.toFixed(2),
        qty90d: entry.qty90d,
        source: 'orders_api' as const,
        rank: entry.rank,
        computedAt: now,
      })),
    )
    .onConflictDoUpdate({
      target: [topProducts.accountId, topProducts.productId],
      set: {
        title: sql`excluded.title`,
        url: sql`excluded.url`,
        revenue90d: sql`excluded.revenue_90d`,
        qty90d: sql`excluded.qty_90d`,
        source: sql`excluded.source`,
        rank: sql`excluded.rank`,
        computedAt: sql`excluded.computed_at`,
      },
    })
  return ranked.length
}

export type TopProductRow = typeof topProducts.$inferSelect

export async function listTopProducts(db: Db, scope: AccountScope): Promise<TopProductRow[]> {
  return db
    .select()
    .from(topProducts)
    .where(eq(topProducts.accountId, scope.accountId))
    .orderBy(topProducts.rank)
}

/**
 * The confirmation screen's edit to the best-seller list: dragged into a new
 * order, and anything the merchant removed left out of `orderedProductIds`.
 *
 * A merchant's edit rather than the 90-day recompute that owns this table the
 * rest of the time (`replaceTopProducts` above) — so this never inserts a row
 * the sync did not already write, only reorders or deletes what is there. An id
 * that names another account's product, or no product at all, is silently
 * skipped: the ids on this screen came from a `GET /api/profile` this account
 * was handed, but a stale client holding an old list must not be able to touch
 * a row it does not own.
 */
export async function reorderTopProducts(
  db: Db,
  scope: AccountScope,
  orderedProductIds: readonly string[],
): Promise<void> {
  const held = await listTopProducts(db, scope)
  const heldIds = new Set(held.map((row) => row.productId))
  const kept = orderedProductIds.filter((id) => heldIds.has(id))
  const keptSet = new Set(kept)

  const drop = held.filter((row) => !keptSet.has(row.productId)).map((row) => row.productId)
  if (drop.length > 0) {
    await db
      .delete(topProducts)
      .where(and(eq(topProducts.accountId, scope.accountId), inArray(topProducts.productId, drop)))
  }

  for (const [index, productId] of kept.entries()) {
    await db
      .update(topProducts)
      .set({ rank: index + 1 })
      .where(and(eq(topProducts.accountId, scope.accountId), eq(topProducts.productId, productId)))
  }
}

/** One landing page's takings on one day. */
export interface LandingRevenueInput {
  readonly date: string
  readonly landingUrl: string
  readonly ordersN: number
  readonly revenue: number
  readonly currency: string
}

/**
 * Writes the day's takings per landing page.
 *
 * A replace, not an increment. That is what makes a resumed sync safe: a run
 * killed after writing a day and before recording that it had done so re-reads
 * the same orders and writes the same totals, rather than adding them a second
 * time.
 */
export async function upsertLandingRevenue(
  db: Db,
  scope: AccountScope,
  rows: readonly LandingRevenueInput[],
): Promise<number> {
  if (rows.length === 0) return 0
  await db
    .insert(landingRevenueDaily)
    .values(
      rows.map((row) => ({
        accountId: scope.accountId,
        date: row.date,
        landingUrl: row.landingUrl,
        ordersN: row.ordersN,
        revenue: row.revenue.toFixed(2),
        currency: row.currency,
      })),
    )
    .onConflictDoUpdate({
      target: [landingRevenueDaily.accountId, landingRevenueDaily.date, landingRevenueDaily.landingUrl],
      set: {
        ordersN: sql`excluded.orders_n`,
        revenue: sql`excluded.revenue`,
        currency: sql`excluded.currency`,
      },
    })
  return rows.length
}

export async function listLandingRevenue(db: Db, scope: AccountScope) {
  return db
    .select()
    .from(landingRevenueDaily)
    .where(eq(landingRevenueDaily.accountId, scope.accountId))
    .orderBy(landingRevenueDaily.date, landingRevenueDaily.landingUrl)
}

/**
 * Every store we currently hold a working connection to.
 *
 * Deliberately unscoped — choosing which stores a nightly sweep works for is
 * the whole question — and only live connections count: a store whose token
 * died has nothing we could read.
 */
export async function accountsWithLiveShopifyConnectionAndHandle(
  db: Db,
  _scope: SystemScope,
): Promise<{ accountId: string; shopHandle: string }[]> {
  return db
    .select({ accountId: shopifyConns.accountId, shopHandle: shopifyConns.shopHandle })
    .from(shopifyConns)
    .where(isNull(shopifyConns.invalidatedAt))
    .orderBy(shopifyConns.accountId)
}

/**
 * Products the store did not show us this time round.
 *
 * The sweep stamps every product it sees, so anything still carrying a stamp
 * from before the walk began is one Shopify no longer lists — deleted, or
 * archived out of the API's sight. Asked this way rather than by accumulating
 * ids in memory, so a sweep spread over several runs still gets the right
 * answer.
 */
export async function productsNotSyncedSince(
  db: Db,
  scope: AccountScope,
  since: Date,
): Promise<{ id: string; shopifyProductId: string }[]> {
  return db
    .select({ id: products.id, shopifyProductId: products.shopifyProductId })
    .from(products)
    .where(and(eq(products.accountId, scope.accountId), lt(products.syncedAt, since)))
    .orderBy(products.shopifyProductId)
}

/**
 * One product, as the distillation step reads it.
 *
 * There is no description in this shape, only the plain text of one — because
 * the quarantine on a merchant's raw description is not a rule people remember,
 * it is a boundary this file is the only side of. Everything past here holds
 * text that has already been stripped of markup and capped in length, and the
 * step that calls this never sees the stored bytes at all.
 */
export interface DistillableProductRecord {
  readonly id: string
  readonly shopifyProductId: string
  readonly title: string
  /** The description as plain text, ready for the model. Empty when the product has none. */
  readonly descriptionText: string
  readonly priceRange: { readonly min: number; readonly max: number } | null
  /** The store's own option axes, merged into the sheet rather than extracted from prose. */
  readonly options: readonly ProductOption[]
  /** The two halves of the distillation key: re-running an unchanged product is a no-op by construction. */
  readonly updatedAt: Date | null
  readonly checksum: string | null
}

/**
 * A page of the store's products for distillation, in id order.
 *
 * Paged rather than read whole: a large catalogue's descriptions are the
 * bulkiest thing we hold, and the step processes them one batch at a time so a
 * thousand-product store never has a thousand descriptions in memory at once.
 */
export async function productsForDistillation(
  db: Db,
  scope: AccountScope,
  options: { after?: string; limit: number },
): Promise<DistillableProductRecord[]> {
  const rows = await db
    .select({
      id: products.id,
      shopifyProductId: products.shopifyProductId,
      title: products.title,
      rawBodyHtml: products.rawBodyHtml,
      priceRange: products.priceRange,
      options: products.options,
      updatedAt: products.updatedAt,
      checksum: products.checksum,
    })
    .from(products)
    .where(
      options.after
        ? and(eq(products.accountId, scope.accountId), gt(products.id, options.after))
        : eq(products.accountId, scope.accountId),
    )
    .orderBy(asc(products.id))
    .limit(options.limit)

  return rows.map((row) => ({
    id: row.id,
    shopifyProductId: row.shopifyProductId,
    title: row.title,
    descriptionText: descriptionText(readProductBody(row)),
    priceRange: (row.priceRange ?? null) as DistillableProductRecord['priceRange'],
    options: storedOptions(row.options),
    updatedAt: row.updatedAt,
    checksum: row.checksum,
  }))
}

/**
 * The option column, read back defensively.
 *
 * The column takes whatever Shopify sent and the database validates none of it,
 * so a reader that trusted the shape would hand a malformed row straight into
 * grouping. Anything that is not a named axis is dropped here rather than
 * further in, where the damage would be an invented comparison heading on a
 * merchant's screen.
 */
/**
 * The metafield column, read back defensively, for the same reason as the
 * options one: the database validates nothing about what Shopify sent.
 */
export function storedMetafields(value: unknown): readonly ProductMetafield[] {
  if (!Array.isArray(value)) return []
  const out: ProductMetafield[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const key = record['key']
    const raw = record['value']
    if (typeof key !== 'string' || key.trim() === '') continue
    if (typeof raw !== 'string' || raw.trim() === '') continue
    out.push({
      namespace: typeof record['namespace'] === 'string' ? record['namespace'] : '',
      key: key.trim(),
      value: raw.trim(),
      type: typeof record['type'] === 'string' && record['type'] !== '' ? record['type'] : null,
    })
  }
  return out
}

export function storedOptions(value: unknown): readonly ProductOption[] {
  if (!Array.isArray(value)) return []
  const out: ProductOption[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const name = (entry as { name?: unknown }).name
    if (typeof name !== 'string' || name.trim() === '') continue
    const raw = (entry as { values?: unknown }).values
    const values = Array.isArray(raw)
      ? raw.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim())
      : []
    out.push({ name: name.trim(), values })
  }
  return out
}

/** The product's quarantined description, read back as text. */
export function readProductBody(row: Pick<ProductRecord, 'rawBodyHtml'>): string | null {
  if (!row.rawBodyHtml) return null
  return gunzipSync(row.rawBodyHtml).toString('utf8')
}

function compressBody(bodyHtml: string | null): Buffer | null {
  if (bodyHtml === null) return null
  return gzipSync(Buffer.from(bodyHtml, 'utf8'))
}
