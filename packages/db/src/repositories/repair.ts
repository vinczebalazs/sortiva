import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import type { Db } from '../client'
import {
  accountSettings,
  articleProductRefs,
  articles,
  opportunities,
  opportunityTasks,
  productFacts,
  productFamilies,
  products,
  publishIntents,
  webhookEvents,
} from '../schema'
import type { AccountScope, SystemScope } from '../scope'
import { assertMoveIsDrawn } from './opportunity-moves'

/**
 * What the daily repair pass needs to see, and the two things it writes.
 *
 * The reads are deliberately narrow. A store can have thousands of products and
 * a handful of published articles, and only the products those articles
 * actually name can break one — so every query here starts from
 * `article_product_refs` and works outwards, never from the catalogue.
 */

/** The two signal types that mean "a published article has stopped being true". */
export const REPAIR_SIGNAL_TYPES = ['broken_product_reference', 'product_change_impact'] as const

const OPEN_STATUSES = ['new', 'accepted', 'scheduled', 'executing', 'blocked'] as const

/** Topics we invent for our own change rows. Mirrors `catalog-events.ts`, which owns the writing side. */
const CHANGE_TOPIC_PREFIX = 'catalog_change/'

export interface RepairSettingsRow {
  /** How this store's articles reach it: posted by us, or downloaded by them. */
  readonly delivery: 'auto' | 'export'
  /** Whether we may put a corrected article back on their shop without asking. */
  readonly autoRepair: boolean
  readonly vacationMode: boolean
}

/**
 * The three settings a repair turns on.
 *
 * Its own read rather than a wider settings one, because `auto_repair` is the
 * only place in the product this column is consulted and adding it to a shared
 * accessor would put it in front of every caller that does not care.
 */
export async function readRepairSettings(
  db: Db,
  scope: AccountScope,
): Promise<RepairSettingsRow> {
  const [row] = await db
    .select({
      delivery: accountSettings.delivery,
      autoRepair: accountSettings.autoRepair,
      vacationMode: accountSettings.vacationMode,
    })
    .from(accountSettings)
    .where(eq(accountSettings.accountId, scope.accountId))
    .limit(1)
  // No settings row means a store that has changed nothing, and the schema's
  // own defaults are what it would have: export delivery, repairs on.
  return row ?? { delivery: 'export', autoRepair: true, vacationMode: false }
}

export interface ReferencedProductRow {
  readonly articleId: string
  readonly articleTitle: string
  readonly articleState: string
  readonly articleDelivery: 'auto' | 'export'
  readonly articleBody: unknown
  readonly refId: string
  readonly placeholderKey: string
  readonly refType: 'link' | 'recommendation' | 'mention'
  readonly productId: string | null
  readonly productTitle: string | null
  readonly shopifyProductId: string | null
  readonly familyId: string | null
  readonly variants: unknown
}

/**
 * Every product mention in every article this store has actually published.
 *
 * Drafts and rejected articles are left out on purpose: nothing outside this
 * app can see them, so nothing about them can be wrong in a way a reader
 * suffers, and repairing one would spend an external write on a page that does
 * not exist.
 */
export async function publishedArticleProductRefs(
  db: Db,
  scope: AccountScope,
): Promise<readonly ReferencedProductRow[]> {
  const rows = await db
    .select({
      articleId: articles.id,
      articleTitle: articles.title,
      articleState: articles.state,
      articleDelivery: articles.delivery,
      articleBody: articles.bodyJson,
      refId: articleProductRefs.id,
      placeholderKey: articleProductRefs.placeholderKey,
      refType: articleProductRefs.refType,
      productId: articleProductRefs.productId,
      productTitle: products.title,
      shopifyProductId: products.shopifyProductId,
      familyId: products.familyId,
      variants: products.variants,
    })
    .from(articleProductRefs)
    .innerJoin(articles, eq(articleProductRefs.articleId, articles.id))
    .leftJoin(products, eq(articleProductRefs.productId, products.id))
    .where(and(eq(articles.accountId, scope.accountId), eq(articles.state, 'published')))
    .orderBy(articles.id, articleProductRefs.placeholderKey)

  return rows as readonly ReferencedProductRow[]
}

/**
 * Which of this store's products the store itself has told us are gone.
 *
 * Read from the shared change record rather than from the catalogue, because
 * nothing deletes a local product row — what a deletion leaves behind is the
 * change entry, and that entry is the only evidence the product ever went. The
 * answer is Shopify's own ids, which is what the record carries.
 */
export async function deletedShopifyProductIds(
  db: Db,
  _scope: SystemScope,
  accountId: string,
  since: Date,
): Promise<readonly string[]> {
  const rows = await db
    .select({ entityId: sql<string>`${webhookEvents.payload} ->> 'entity_id'` })
    .from(webhookEvents)
    .where(
      and(
        eq(webhookEvents.topic, `${CHANGE_TOPIC_PREFIX}product_deleted`),
        sql`${webhookEvents.payload} ->> 'account_id' = ${accountId}`,
        sql`${webhookEvents.receivedAt} >= ${since.toISOString()}::timestamptz`,
      ),
    )
  return [...new Set(rows.map((row) => row.entityId).filter((id): id is string => Boolean(id)))]
}

/**
 * When each named product's stock last moved, as the store reported it.
 *
 * There is no "unbuyable since" column anywhere, and this is the nearest thing
 * to one we hold: a product currently unbuyable went unbuyable at the last
 * moment its availability changed. Deliveries are pruned at thirty days, so a
 * product that has been out of stock for longer than that and has not moved
 * since answers with nothing — see DECISIONS 2026-09-04 T5.3.
 */
export async function lastAvailabilityChangeAt(
  db: Db,
  _scope: SystemScope,
  accountId: string,
  shopifyProductIds: readonly string[],
): Promise<ReadonlyMap<string, Date>> {
  if (shopifyProductIds.length === 0) return new Map()
  const rows = await db
    .select({
      entityId: sql<string>`${webhookEvents.payload} ->> 'entity_id'`,
      occurredAt: sql<string>`max(${webhookEvents.payload} ->> 'occurred_at')`,
    })
    .from(webhookEvents)
    .where(
      and(
        eq(webhookEvents.topic, `${CHANGE_TOPIC_PREFIX}availability_changed`),
        sql`${webhookEvents.payload} ->> 'account_id' = ${accountId}`,
        // Parameterised rather than interpolated: the ids come from the
        // store's own rows, but a query built by string concatenation is a
        // query that can be made to mean something else, and this one has no
        // reason to be.
        inArray(sql`${webhookEvents.payload} ->> 'entity_id'`, [...shopifyProductIds]),
      ),
    )
    .groupBy(sql`${webhookEvents.payload} ->> 'entity_id'`)

  const out = new Map<string, Date>()
  for (const row of rows) {
    const at = new Date(row.occurredAt)
    if (row.entityId && !Number.isNaN(at.getTime())) out.set(row.entityId, at)
  }
  return out
}

export interface FamilyAxesRow {
  readonly familyId: string
  readonly differentiationAxes: readonly string[]
}

/** The attributes each named range currently differs by. */
export async function familyAxes(
  db: Db,
  scope: AccountScope,
  familyIds: readonly string[],
): Promise<readonly FamilyAxesRow[]> {
  if (familyIds.length === 0) return []
  const rows = await db
    .select({
      familyId: productFamilies.id,
      differentiationAxes: productFamilies.differentiationAxes,
    })
    .from(productFamilies)
    .where(
      and(eq(productFamilies.accountId, scope.accountId), inArray(productFamilies.id, [...familyIds])),
    )
  return rows
}

export interface FamilyMemberRow {
  readonly productId: string
  readonly title: string
  readonly familyId: string | null
  readonly variants: unknown
  readonly factKeys: readonly string[]
}

/**
 * Everything the store still sells in the named ranges, with what we know about
 * each — the pool a stand-in for a withdrawn product is chosen from.
 */
export async function familyMembersWithFacts(
  db: Db,
  scope: AccountScope,
  familyIds: readonly string[],
): Promise<readonly FamilyMemberRow[]> {
  if (familyIds.length === 0) return []
  const rows = await db
    .select({
      productId: products.id,
      title: products.title,
      familyId: products.familyId,
      variants: products.variants,
      facts: productFacts.factsJson,
    })
    .from(products)
    .leftJoin(productFacts, eq(productFacts.productId, products.id))
    .where(and(eq(products.accountId, scope.accountId), inArray(products.familyId, [...familyIds])))

  return rows.map((row) => ({
    productId: row.productId,
    title: row.title,
    familyId: row.familyId,
    variants: row.variants,
    factKeys: factKeysOf(row.facts),
  }))
}

/** A fact sheet's populated field names. A null value is a field distillation deliberately left empty, and counts as absent. */
export function factKeysOf(facts: unknown): readonly string[] {
  if (!facts || typeof facts !== 'object' || Array.isArray(facts)) return []
  return Object.entries(facts as Record<string, unknown>)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key]) => key)
}

/**
 * Points one product mention at a different product.
 *
 * Guarded on the reference still naming the product we decided to replace: a
 * second worker that already repaired it matches no rows, and this one stops
 * rather than swapping a swap. The previously resolved values are cleared with
 * it, because they describe a product this mention no longer means.
 */
export async function repointArticleProductRef(
  db: Db,
  scope: AccountScope,
  input: { readonly refId: string; readonly fromProductId: string; readonly toProductId: string },
): Promise<boolean> {
  const [row] = await db
    .update(articleProductRefs)
    .set({ productId: input.toProductId, resolvedValuesJson: {}, resolvedAt: null })
    .where(
      and(
        eq(articleProductRefs.id, input.refId),
        eq(articleProductRefs.productId, input.fromProductId),
        // The article has to belong to this account. `article_product_refs`
        // carries no account column of its own, so the scope is applied through
        // the article it hangs off rather than being taken on trust.
        sql`${articleProductRefs.articleId} IN (SELECT id FROM ${articles} WHERE ${articles.accountId} = ${scope.accountId})`,
      ),
    )
    .returning({ id: articleProductRefs.id })
  return row !== undefined
}

export interface OpenRepairRow {
  readonly opportunityId: string
  readonly articleId: string
  readonly signalType: string
  readonly recommendedAction: string
  readonly since: Date
  /** What this repair has already changed, where it has changed anything yet. */
  readonly outcome: unknown
}

/** Every repair this store has open, whether it is waiting on us or on them. */
export async function openRepairs(
  db: Db,
  scope: AccountScope,
): Promise<readonly OpenRepairRow[]> {
  const rows = await db
    .select({
      opportunityId: opportunities.id,
      articleId: opportunities.entityRef,
      signalType: opportunities.signalType,
      recommendedAction: opportunities.recommendedAction,
      since: opportunities.detectedAt,
      outcome: opportunities.outcomeJson,
    })
    .from(opportunities)
    .where(
      and(
        eq(opportunities.accountId, scope.accountId),
        eq(opportunities.entityType, 'article'),
        inArray(opportunities.signalType, [...REPAIR_SIGNAL_TYPES]),
        inArray(opportunities.status, [...OPEN_STATUSES]),
      ),
    )
    .orderBy(opportunities.detectedAt)
  return rows as readonly OpenRepairRow[]
}

/**
 * Finishes a repair, with the record of what it changed.
 *
 * Guarded on the row still being open, so a redelivered job cannot write a
 * second, contradictory account of the same repair over the first.
 */
export async function completeRepair(
  db: Db,
  scope: AccountScope,
  opportunityId: string,
  outcome: Record<string, unknown>,
  now: Date = new Date(),
): Promise<boolean> {
  assertMoveIsDrawn(OPEN_STATUSES, 'completed')
  const [row] = await db
    .update(opportunities)
    .set({ status: 'completed', outcomeJson: outcome, appliedAt: now, updatedAt: now })
    .where(
      and(
        eq(opportunities.id, opportunityId),
        eq(opportunities.accountId, scope.accountId),
        inArray(opportunities.status, [...OPEN_STATUSES]),
      ),
    )
    .returning({ id: opportunities.id })
  return row !== undefined
}

/**
 * Records what a repair changed without saying it is finished.
 *
 * A store that publishes for itself has its copy here corrected the moment the
 * drift is found, and the card on its dashboard stands until it replaces the
 * live page. Writing the log at that point rather than at completion is what
 * makes the repair history true while the card is still open; using
 * `completeRepair` for it would take the card off the dashboard before the
 * merchant had done anything.
 */
export async function recordRepairProgress(
  db: Db,
  scope: AccountScope,
  opportunityId: string,
  outcome: Record<string, unknown>,
  now: Date = new Date(),
): Promise<boolean> {
  const [row] = await db
    .update(opportunities)
    .set({ outcomeJson: outcome, updatedAt: now })
    .where(
      and(
        eq(opportunities.id, opportunityId),
        eq(opportunities.accountId, scope.accountId),
        inArray(opportunities.status, [...OPEN_STATUSES]),
      ),
    )
    .returning({ id: opportunities.id })
  return row !== undefined
}

/** Marks the merchant-facing tasks on a repair done, once the repair itself is. */
export async function closeRepairTasks(
  db: Db,
  _scope: AccountScope,
  opportunityId: string,
  now: Date = new Date(),
): Promise<number> {
  const rows = await db
    .update(opportunityTasks)
    .set({ state: 'applied', appliedAt: now })
    .where(
      and(eq(opportunityTasks.opportunityId, opportunityId), eq(opportunityTasks.state, 'open')),
    )
    .returning({ id: opportunityTasks.id })
  return rows.length
}

/**
 * Everything ever repaired on one article, oldest first — the history behind
 * the "repaired" badge on the article screen.
 */
export async function repairHistory(
  db: Db,
  scope: AccountScope,
  articleId: string,
): Promise<readonly { readonly opportunityId: string; readonly outcome: unknown; readonly at: Date }[]> {
  const rows = await db
    .select({
      opportunityId: opportunities.id,
      outcome: opportunities.outcomeJson,
      // The moment the repair changed something, which is not the same as the
      // moment it finished: a store that publishes for itself has its copy
      // corrected long before it replaces the live page.
      at: opportunities.updatedAt,
    })
    .from(opportunities)
    .where(
      and(
        eq(opportunities.accountId, scope.accountId),
        eq(opportunities.entityType, 'article'),
        eq(opportunities.entityRef, articleId),
        inArray(opportunities.signalType, [...REPAIR_SIGNAL_TYPES]),
        isNotNull(opportunities.outcomeJson),
      ),
    )
    .orderBy(opportunities.updatedAt)
  return rows.map((row) => ({
    opportunityId: row.opportunityId,
    outcome: row.outcome,
    at: row.at,
  }))
}

/**
 * The highest revision of this article we have already claimed, so the next
 * republication gets a number of its own.
 *
 * Read from the publication claims rather than from the repair log, because a
 * claim is written before anything is sent and survives a worker dying halfway:
 * counting finished repairs instead would hand a crashed attempt's number out
 * twice, and the claim's unique key would then refuse the second one.
 */
export async function highestPublishedRevision(
  db: Db,
  scope: AccountScope,
  articleId: string,
): Promise<number> {
  const marker = `sortiva-${articleId}`
  const rows = await db
    .select({ revisionN: publishIntents.revisionN })
    .from(publishIntents)
    .where(
      and(
        eq(publishIntents.accountId, scope.accountId),
        sql`${publishIntents.articleExternalId} = ${marker} OR ${publishIntents.articleExternalId} LIKE ${`${marker}#r%`}`,
      ),
    )
    .orderBy(desc(publishIntents.revisionN))
    .limit(1)
  return rows[0]?.revisionN ?? 0
}
