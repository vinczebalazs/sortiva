import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { FactSheet } from '@sortiva/core'
import type { Db } from '../client'
import { productFacts, productFamilies, products } from '../schema'
import type { AccountScope } from '../scope'

/**
 * Product families: the store's catalogue as a handful of subjects rather than
 * hundreds of rows.
 *
 * Everything downstream — topic mapping, the substance inventory, evidence
 * packs, cannibalization — reads families and never individual products, so
 * these rows are what decides how many things a store can honestly be written
 * about. A store of forty shoes with four families supports a handful of buying
 * guides; the same store with forty families would produce forty thin articles
 * about the same shoe.
 */

/** One product as grouping reads it: facts and taxonomy, never the description. */
export interface GroupableProduct {
  readonly productId: string
  readonly shopifyProductId: string
  readonly title: string
  readonly productType: string | null
  readonly tags: readonly string[]
  /** Null for a product distillation has not reached yet. */
  readonly factSheet: FactSheet | null
  readonly checksum: string | null
  /** When the fact sheet was made. Half of what tells a re-run it has nothing new to do. */
  readonly distilledAt: Date | null
}

/**
 * The whole catalogue, with each product's fact sheet beside it.
 *
 * Read whole rather than paged, unlike distillation: a family is a property of
 * the entire catalogue, and a page of it cannot be grouped in isolation — two
 * products on different pages may be the same family, and the answer would
 * depend on where the page boundary fell. There is no description in this
 * shape, so the quarantine holds by construction rather than by care.
 */
export async function productsForGrouping(
  db: Db,
  scope: AccountScope,
): Promise<GroupableProduct[]> {
  const rows = await db
    .select({
      productId: products.id,
      shopifyProductId: products.shopifyProductId,
      title: products.title,
      productType: products.productType,
      tags: products.tags,
      checksum: products.checksum,
      factsJson: productFacts.factsJson,
      distilledAt: productFacts.distilledAt,
    })
    .from(products)
    .leftJoin(productFacts, eq(productFacts.productId, products.id))
    .where(eq(products.accountId, scope.accountId))
    .orderBy(products.id)

  return rows.map((row) => ({
    productId: row.productId,
    shopifyProductId: row.shopifyProductId,
    title: row.title,
    productType: row.productType,
    tags: row.tags ?? [],
    factSheet: (row.factsJson ?? null) as FactSheet | null,
    checksum: row.checksum,
    distilledAt: row.distilledAt,
  }))
}

/** One family as it is to be written. */
export interface FamilyInput {
  /** Also the family's identity across runs: a recompute matches on this. */
  readonly name: string
  readonly memberProductIds: readonly string[]
  readonly differentiationAxes: readonly string[]
  readonly mergedFacts: unknown
  readonly groupingSource: 'collection' | 'split_variant' | 'fact_cluster' | 'embedding'
  readonly confidence: 'low' | 'medium' | 'high'
}

export interface FamilyReconciliation {
  readonly created: number
  readonly updated: number
  readonly removed: number
  readonly productsAssigned: number
}

/**
 * Writes a whole store's families, keeping the rows that already describe the
 * same family.
 *
 * An update in place rather than a delete and re-insert, because two other
 * tables point at these ids — `products.family_id`, and the store-page
 * inventory's `family_ids` — and replacing every row nightly would break both
 * every night. Matching is on the name, which is derived deterministically from
 * whatever produced the family; there is no key column to hold something
 * better. See DECISIONS 2026-09-02 T2.4.
 *
 * The whole reconciliation is one transaction. A crash halfway through would
 * otherwise leave a store with some products pointing at families that were
 * about to be deleted, which is a state nothing downstream knows how to read.
 */
export async function reconcileFamilies(
  db: Db,
  scope: AccountScope,
  plan: readonly FamilyInput[],
  logicalProducts: ReadonlyMap<string, string>,
  now: Date = new Date(),
): Promise<FamilyReconciliation> {
  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: productFamilies.id, name: productFamilies.name })
      .from(productFamilies)
      .where(eq(productFamilies.accountId, scope.accountId))

    const byName = new Map(existing.map((row) => [row.name, row.id]))
    const keep = new Set<string>()
    let created = 0
    let updated = 0
    let productsAssigned = 0

    for (const family of plan) {
      const values = {
        name: family.name,
        mergedFactsJson: family.mergedFacts as never,
        differentiationAxes: [...family.differentiationAxes],
        memberCount: family.memberProductIds.length,
        groupingSource: family.groupingSource,
        confidence: family.confidence,
        computedAt: now,
      }

      const known = byName.get(family.name)
      let familyId: string
      if (known) {
        await tx.update(productFamilies).set(values).where(eq(productFamilies.id, known))
        familyId = known
        updated += 1
      } else {
        const [row] = await tx
          .insert(productFamilies)
          .values({ accountId: scope.accountId, ...values })
          .returning({ id: productFamilies.id })
        if (!row) throw new Error(`failed to write product family "${family.name}"`)
        familyId = row.id
        created += 1
      }
      keep.add(familyId)

      if (family.memberProductIds.length > 0) {
        await tx
          .update(products)
          .set({ familyId })
          .where(
            and(
              eq(products.accountId, scope.accountId),
              inArray(products.id, [...family.memberProductIds]),
            ),
          )
        productsAssigned += family.memberProductIds.length
      }
    }

    // Split-variant merges, written per group rather than per family: two rows
    // that are one product may sit in a family with thirty others, and it is
    // the pair that is one product, not the family.
    const groups = new Map<string, string[]>()
    for (const [productId, groupKey] of logicalProducts) {
      const bucket = groups.get(groupKey) ?? []
      bucket.push(productId)
      groups.set(groupKey, bucket)
    }
    const merged = [...groups.entries()].filter(([, members]) => members.length > 1)
    const singles = [...groups.entries()]
      .filter(([, members]) => members.length === 1)
      .flatMap(([, members]) => members)

    for (const [groupKey, members] of merged) {
      await tx
        .update(products)
        .set({ logicalProductId: groupKey })
        .where(and(eq(products.accountId, scope.accountId), inArray(products.id, members)))
    }
    if (singles.length > 0) {
      // A product that stopped being a split variant — the merchant renamed it,
      // or gave it a real description — must lose the marker, or it stays
      // welded to a row it no longer matches.
      await tx
        .update(products)
        .set({ logicalProductId: null })
        .where(and(eq(products.accountId, scope.accountId), inArray(products.id, singles)))
    }

    const stale = existing.filter((row) => !keep.has(row.id)).map((row) => row.id)
    if (stale.length > 0) {
      await tx.delete(productFamilies).where(inArray(productFamilies.id, stale))
    }

    return { created, updated, removed: stale.length, productsAssigned }
  })
}

export interface FamilyRecord {
  readonly id: string
  readonly name: string
  readonly memberCount: number
  readonly differentiationAxes: readonly string[]
  readonly groupingSource: string
  readonly confidence: string
  readonly computedAt: Date
}

/** Every family this store has, oldest first, for a screen or a report. */
export async function listFamilies(db: Db, scope: AccountScope): Promise<FamilyRecord[]> {
  const rows = await db
    .select()
    .from(productFamilies)
    .where(eq(productFamilies.accountId, scope.accountId))
    .orderBy(productFamilies.name)

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    memberCount: row.memberCount,
    differentiationAxes: row.differentiationAxes,
    groupingSource: row.groupingSource,
    confidence: row.confidence,
    computedAt: row.computedAt,
  }))
}

/**
 * One family, scoped to the account that owns it.
 *
 * Scoped rather than fetched by id alone, so a family id belonging to another
 * merchant answers "not found" rather than returning their catalogue's shape.
 */
export async function findFamily(
  db: Db,
  scope: AccountScope,
  familyId: string,
): Promise<FamilyRecord | undefined> {
  const [row] = await db
    .select()
    .from(productFamilies)
    .where(and(eq(productFamilies.id, familyId), eq(productFamilies.accountId, scope.accountId)))
    .limit(1)

  if (!row) return undefined
  return {
    id: row.id,
    name: row.name,
    memberCount: row.memberCount,
    differentiationAxes: row.differentiationAxes,
    groupingSource: row.groupingSource,
    confidence: row.confidence,
    computedAt: row.computedAt,
  }
}

/** Every named family among the given ids, for the evidence-pack assembly step (`packages/jobs/src/generation`) — one round trip for a topic's whole `family_ids` array. */
export async function findFamiliesByIds(
  db: Db,
  scope: AccountScope,
  familyIds: readonly string[],
): Promise<FamilyRecord[]> {
  if (familyIds.length === 0) return []
  const rows = await db
    .select()
    .from(productFamilies)
    .where(and(eq(productFamilies.accountId, scope.accountId), inArray(productFamilies.id, [...familyIds])))

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    memberCount: row.memberCount,
    differentiationAxes: row.differentiationAxes,
    groupingSource: row.groupingSource,
    confidence: row.confidence,
    computedAt: row.computedAt,
  }))
}

/** How many of this store's products no family has claimed. Zero after a successful grouping. */
export async function ungroupedProductCount(db: Db, scope: AccountScope): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(products)
    .where(and(eq(products.accountId, scope.accountId), isNull(products.familyId)))
  return row?.count ?? 0
}
