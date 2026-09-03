import { eq, sql } from 'drizzle-orm'
import type { FactSheet } from '@sortiva/core'
import type { Db } from '../client'
import { accountSettings, personas, productFamilies, products } from '../schema'
import type { AccountScope } from '../scope'

/**
 * The store's business profile, and the settings that follow from it.
 *
 * One row per account, written once during onboarding and then confirmed or
 * corrected by the merchant. Everything the product later writes is written in
 * this row's language, for this row's audience, in this row's register — and
 * every paid search lookup is made with its language and country — so it is a
 * small table with an unusually long reach.
 */

/** One family as the persona call needs to see it: shared facts and the axes members differ along. */
export interface FamilyForPersona {
  readonly name: string
  readonly memberCount: number
  readonly differentiationAxes: readonly string[]
  readonly mergedFacts: FactSheet
}

/**
 * The store's families, with the merged fact sheet `listFamilies` leaves out.
 *
 * A second reader rather than a wider `listFamilies`, because the two answer
 * different questions: the screen wants a family's name, size and provenance,
 * and this wants what its members agree on. Loading a fact sheet per family for
 * a list view would be paying for a column nobody renders.
 */
export async function familiesForPersona(
  db: Db,
  scope: AccountScope,
): Promise<FamilyForPersona[]> {
  const rows = await db
    .select({
      name: productFamilies.name,
      memberCount: productFamilies.memberCount,
      differentiationAxes: productFamilies.differentiationAxes,
      mergedFactsJson: productFamilies.mergedFactsJson,
    })
    .from(productFamilies)
    .where(eq(productFamilies.accountId, scope.accountId))
    .orderBy(productFamilies.name)

  return rows.map((row) => ({
    name: row.name,
    memberCount: row.memberCount,
    differentiationAxes: row.differentiationAxes,
    mergedFacts: (row.mergedFactsJson ?? {}) as FactSheet,
  }))
}

/** How many products this store has, families or not. What "breadth" is measured against. */
export async function countCatalogProducts(db: Db, scope: AccountScope): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(products)
    .where(eq(products.accountId, scope.accountId))
  return row?.count ?? 0
}

export interface PersonaWrite {
  readonly description: string
  readonly productCategories: readonly string[]
  readonly language: string
  readonly country: string
  readonly audience: string
  readonly tone: string
  /**
   * How much we actually know about this catalogue, rolled up from the
   * per-product fact counts. Computed at distillation and stored here, because
   * this is the row the confirmation screen and the substance checks read.
   */
  readonly richnessScore: number
  /** Invariant 25 — every model artefact carries the prompt and model that made it. */
  readonly promptVersion: string
  readonly modelId: string
}

/**
 * Writes the profile, replacing whatever we held.
 *
 * A replace rather than a merge, for the same reason a fact sheet is: the
 * profile is one answer to one question asked over the whole catalogue, and
 * keeping half of an older answer beside half of a newer one would describe a
 * store that never existed.
 *
 * `confirmed_at` is deliberately untouched. It records that a human agreed with
 * us, and a later recompute has not been agreed with — clearing it is the
 * merchant's confirmation step's business, and re-asserting it would be us
 * claiming their approval for words they have not read.
 */
export async function upsertPersona(
  db: Db,
  scope: AccountScope,
  input: PersonaWrite,
  now: Date = new Date(),
): Promise<void> {
  const values = {
    description: input.description,
    productCategories: [...input.productCategories],
    language: input.language,
    country: input.country,
    audience: input.audience,
    tone: input.tone,
    richnessScore: input.richnessScore.toFixed(2),
    promptVersion: input.promptVersion,
    modelId: input.modelId,
    generatedAt: now,
  }

  await db
    .insert(personas)
    .values({ accountId: scope.accountId, ...values })
    .onConflictDoUpdate({ target: personas.accountId, set: values })
}

export interface StoredPersona extends PersonaWrite {
  readonly generatedAt: Date
  readonly confirmedAt: Date | null
}

export async function readPersona(
  db: Db,
  scope: AccountScope,
): Promise<StoredPersona | undefined> {
  const [row] = await db
    .select()
    .from(personas)
    .where(eq(personas.accountId, scope.accountId))
    .limit(1)

  if (!row) return undefined
  return {
    description: row.description,
    productCategories: row.productCategories,
    language: row.language,
    country: row.country,
    audience: row.audience ?? '',
    tone: row.tone ?? '',
    richnessScore: Number(row.richnessScore ?? 0),
    promptVersion: row.promptVersion,
    modelId: row.modelId,
    generatedAt: row.generatedAt,
    confirmedAt: row.confirmedAt,
  }
}

/**
 * The merchant's edit to the four free-text fields on the confirmation screen,
 * stamped with the moment they confirmed.
 *
 * An `UPDATE`, not the ingestion pipeline's `upsertPersona` replace: this runs
 * only once a row already exists — confirming is impossible before ingestion
 * has produced a profile to confirm — and it must leave `richness_score`,
 * `product_categories`, `prompt_version` and `model_id` exactly as ingestion
 * wrote them. `confirmed_at` is the one column ingestion never touches (see
 * `upsertPersona` above); this is where it is finally set.
 */
export async function confirmPersonaEdits(
  db: Db,
  scope: AccountScope,
  edits: { description: string; language: string; country: string; audience: string; tone: string },
  now: Date,
): Promise<void> {
  await db
    .update(personas)
    .set({
      description: edits.description,
      language: edits.language,
      country: edits.country,
      audience: edits.audience,
      tone: edits.tone,
      confirmedAt: now,
    })
    .where(eq(personas.accountId, scope.accountId))
}

/**
 * Gives a store its publish clock, if it does not already have one.
 *
 * Insert-if-absent rather than an upsert, and that is the whole point of the
 * function. This value is a *default* derived from the country the persona
 * settled on; the settings screen lets a merchant choose a different zone, and
 * a later re-run of onboarding — a re-sync, a redelivered job, a corrected
 * persona — must not quietly move their publishing back to ours. A store that
 * has never had a row gets one; a store that has one keeps it.
 *
 * Returns the zone the account ends up on, which is not necessarily the one
 * passed in.
 */
export async function ensureAccountTimezone(
  db: Db,
  scope: AccountScope,
  timezone: string,
  now: Date = new Date(),
): Promise<string> {
  await db
    .insert(accountSettings)
    .values({ accountId: scope.accountId, timezone, updatedAt: now })
    .onConflictDoNothing({ target: accountSettings.accountId })

  const [row] = await db
    .select({ timezone: accountSettings.timezone })
    .from(accountSettings)
    .where(eq(accountSettings.accountId, scope.accountId))
    .limit(1)

  return row?.timezone ?? timezone
}
