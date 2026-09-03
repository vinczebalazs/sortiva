import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '../client'
import { OPEN_OPPORTUNITY_STATUSES, opportunities } from '../schema'
import type { AccountScope } from '../scope'

export type OpportunityRow = typeof opportunities.$inferSelect

/**
 * The minimal opportunity-writing this lane needs, ahead of the Opportunity
 * Engine's own (`packages/core/opportunities`, Lane C, `T3.6`/`T3.7` —
 * blocked on a founder question, not yet built).
 *
 * `topics.opportunity_id` is `NOT NULL` with no hedge for manual topics
 * (`packages/db/src/schema/content-engine.ts`'s own comment on that column),
 * so a manually-added topic needs *an* opportunity row to point at before it
 * can be written at all. This is that row, kept as plain and as inert as the
 * FK requires: no real impact/confidence scoring (main §7.6's formula is
 * "internal and versioned" and is Lane C's to build) — `impact: 'low'` and
 * `impactScore` / `confidence` both `0` throughout, so an integrator reading
 * the table later sees at a glance that these rows were never scored rather
 * than mistaking them for real Opportunity Engine output.
 * See DECISIONS 2026-09-03 T4.1.
 */
export interface MinimalOpportunityInput {
  readonly signalType: OpportunityRow['signalType']
  readonly entityType: OpportunityRow['entityType']
  readonly entityRef: string
  readonly evidenceJson: unknown
  readonly recommendedAction: OpportunityRow['recommendedAction']
  readonly status: OpportunityRow['status']
  readonly reasonTemplateKey: string
  readonly reasonParams: Readonly<Record<string, string | number>>
  readonly preconditions?: readonly string[]
  readonly limitedIntelligence: boolean
  readonly rulesVersion: string
}

export async function insertMinimalOpportunity(
  db: Db,
  scope: AccountScope,
  input: MinimalOpportunityInput,
  now: Date = new Date(),
): Promise<OpportunityRow> {
  const [row] = await db
    .insert(opportunities)
    .values({
      accountId: scope.accountId,
      signalType: input.signalType,
      entityType: input.entityType,
      entityRef: input.entityRef,
      evidenceJson: input.evidenceJson as never,
      impact: 'low',
      impactScore: 0,
      confidence: 0,
      reasonTemplateKey: input.reasonTemplateKey,
      reasonParamsJson: input.reasonParams as never,
      recommendedAction: input.recommendedAction,
      preconditionsJson: [...(input.preconditions ?? [])] as never,
      status: input.status,
      limitedIntelligence: input.limitedIntelligence,
      rulesVersion: input.rulesVersion,
      detectedAt: now,
      updatedAt: now,
    })
    .returning()
  if (!row) throw new Error('failed to insert the opportunity')
  return row
}

/**
 * The open row for this signal + entity, if one already exists — invariant
 * 10's dedupe read half. A manual add that lands on the same query or the
 * same existing-target URL a real detection already opened must reuse that
 * row rather than fight it for the partial unique index
 * `(account_id, signal_type, entity_ref) WHERE status IN (open statuses)`.
 */
export async function findOpenOpportunity(
  db: Db,
  scope: AccountScope,
  signalType: OpportunityRow['signalType'],
  entityRef: string,
): Promise<OpportunityRow | undefined> {
  const [row] = await db
    .select()
    .from(opportunities)
    .where(
      and(
        eq(opportunities.accountId, scope.accountId),
        eq(opportunities.signalType, signalType),
        eq(opportunities.entityRef, entityRef),
        inArray(opportunities.status, [...OPEN_OPPORTUNITY_STATUSES]),
      ),
    )
    .limit(1)
  return row
}

export async function setOpportunityTopicId(
  db: Db,
  scope: AccountScope,
  opportunityId: string,
  topicId: string,
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(opportunities)
    .set({ topicId, updatedAt: now })
    .where(and(eq(opportunities.accountId, scope.accountId), eq(opportunities.id, opportunityId)))
}
