import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import type { FactSheet } from '@sortiva/core'
import type { Db } from '../client'
import { productFacts, products } from '../schema'
import type { AccountScope } from '../scope'

/**
 * The fact sheets: what each product actually is, with the marketing removed.
 *
 * This table is the only thing about a product's words that anything downstream
 * reads. The description it was distilled from lives in `products` and is
 * quarantined there — persona construction, topic selection, evidence packs and
 * recommendations all read from here instead, which is what stops a merchant's
 * own copy being fed back to them as our writing.
 */

export interface ProductFactsInput {
  /** Our own product row id. */
  readonly productId: string
  readonly factSheet: FactSheet
  /**
   * Whether marketing language was present and dropped. Stored as a flag in an
   * integer column: the extraction reports a yes or no, and the column was
   * declared as a count before the shape of the answer was settled. See
   * DECISIONS 2026-09-02 T2.3.
   */
  readonly fluffDiscarded: boolean
  /** Invariant 25 — every LLM artefact carries the prompt and model that made it. */
  readonly promptVersion: string
  readonly modelId: string
}

/**
 * Writes one product's fact sheet, replacing whatever we held for it.
 *
 * A replace rather than a merge: a sheet is the answer to "what does this
 * product's description say", asked once over the whole description. Keeping
 * fields from an older sheet would leave facts on a product whose description
 * has since had them removed — a merchant who corrects a material would find
 * the old one still in our articles.
 */
export async function upsertProductFacts(
  db: Db,
  _scope: AccountScope,
  input: ProductFactsInput,
  now: Date = new Date(),
): Promise<void> {
  await db
    .insert(productFacts)
    .values({
      productId: input.productId,
      factsJson: input.factSheet as never,
      factCount: input.factSheet.fact_count,
      fluffDiscarded: input.fluffDiscarded ? 1 : 0,
      promptVersion: input.promptVersion,
      modelId: input.modelId,
      distilledAt: now,
    })
    .onConflictDoUpdate({
      target: productFacts.productId,
      set: {
        factsJson: sql`excluded.facts_json`,
        factCount: sql`excluded.fact_count`,
        fluffDiscarded: sql`excluded.fluff_discarded`,
        promptVersion: sql`excluded.prompt_version`,
        modelId: sql`excluded.model_id`,
        distilledAt: sql`excluded.distilled_at`,
      },
    })
}

export interface StoredFactSheet {
  readonly productId: string
  readonly factSheet: FactSheet
  readonly factCount: number
  readonly fluffDiscarded: boolean
  readonly distilledAt: Date
}

/**
 * Every fact sheet we hold for one store.
 *
 * Scoped through the join to `products`, because `product_facts` is keyed on the
 * product and carries no account of its own — reading it unscoped would be
 * reading every merchant's catalogue at once.
 */
export async function productFactsForAccount(
  db: Db,
  scope: AccountScope,
): Promise<StoredFactSheet[]> {
  const rows = await db
    .select({
      productId: productFacts.productId,
      factsJson: productFacts.factsJson,
      factCount: productFacts.factCount,
      fluffDiscarded: productFacts.fluffDiscarded,
      distilledAt: productFacts.distilledAt,
    })
    .from(productFacts)
    .innerJoin(products, eq(products.id, productFacts.productId))
    .where(eq(products.accountId, scope.accountId))
    .orderBy(productFacts.productId)

  return rows.map((row) => ({
    productId: row.productId,
    factSheet: row.factsJson as FactSheet,
    factCount: row.factCount,
    fluffDiscarded: row.fluffDiscarded !== 0,
    distilledAt: row.distilledAt,
  }))
}

/** One product's fact sheet plus the family/title fields Gate 1's substance check needs. */
export interface ProductSubstanceRow {
  readonly productId: string
  readonly title: string
  readonly familyId: string
  readonly factSheet: FactSheet
}

/**
 * The distilled products behind a set of families, for Gate 1's substance
 * inventory (main §8.2 — "do the mapped families' merged fact sheets have
 * enough populated fields across enough member products").
 *
 * A product with no distilled fact sheet yet (still queued, or the family was
 * just formed) is left out rather than counted as contributing nothing — the
 * caller's `substanceInventory()` already treats an absent product as zero
 * facts through `productsConsidered`, and double-counting it here would only
 * duplicate that.
 */
export async function productSubstanceForFamilies(
  db: Db,
  scope: AccountScope,
  familyIds: readonly string[],
): Promise<ProductSubstanceRow[]> {
  if (familyIds.length === 0) return []
  const rows = await db
    .select({
      productId: products.id,
      title: products.title,
      familyId: products.familyId,
      factsJson: productFacts.factsJson,
    })
    .from(products)
    .innerJoin(productFacts, eq(productFacts.productId, products.id))
    .where(
      and(
        eq(products.accountId, scope.accountId),
        inArray(products.familyId, [...familyIds]),
        isNotNull(products.familyId),
      ),
    )
    .orderBy(products.id)

  return rows
    .filter((row): row is typeof row & { familyId: string } => row.familyId !== null)
    .map((row) => ({
      productId: row.productId,
      title: row.title,
      familyId: row.familyId,
      factSheet: row.factsJson as FactSheet,
    }))
}

/** One product's fact sheet, for the single-product path a webhook or a repair takes. */
export async function productFactSheet(
  db: Db,
  scope: AccountScope,
  productId: string,
): Promise<StoredFactSheet | undefined> {
  const [row] = await db
    .select({
      productId: productFacts.productId,
      factsJson: productFacts.factsJson,
      factCount: productFacts.factCount,
      fluffDiscarded: productFacts.fluffDiscarded,
      distilledAt: productFacts.distilledAt,
    })
    .from(productFacts)
    .innerJoin(products, eq(products.id, productFacts.productId))
    .where(and(eq(products.accountId, scope.accountId), eq(productFacts.productId, productId)))
    .limit(1)

  if (!row) return undefined
  return {
    productId: row.productId,
    factSheet: row.factsJson as FactSheet,
    factCount: row.factCount,
    fluffDiscarded: row.fluffDiscarded !== 0,
    distilledAt: row.distilledAt,
  }
}
