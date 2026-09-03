import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import type {
  ExpiryReason,
  OpportunityTaskDraft,
  RankedOpportunityDraft,
} from '@sortiva/core'
import type { Db } from '../client'
import {
  OPEN_OPPORTUNITY_STATUSES,
  dismissedOpportunities,
  opportunities,
  opportunityTasks,
} from '../schema'
import type { AccountScope } from '../scope'

/**
 * Where the opportunity engine's decisions land: one row per open signal, the
 * partial unique index on `(account_id, signal_type, entity_ref)` (schema wave
 * 2, T2.0) doing the dedupe work invariant 10 requires. Everything here is a
 * guarded write — `UPDATE ... WHERE status = expected` — because the queue is
 * at-least-once and two workers can race to write the same row (invariant 18).
 */

export type OpportunityRow = typeof opportunities.$inferSelect
export type OpportunityTaskRow = typeof opportunityTasks.$inferSelect

const LOWERCASE_ACTION: Readonly<Record<RankedOpportunityDraft['recommendedAction'], OpportunityRow['recommendedAction']>> = {
  CREATE: 'create',
  OPTIMIZE: 'optimize',
  REFRESH: 'refresh',
  FIX: 'fix',
  HOLD: 'hold',
}

/**
 * Writes one detected opportunity. A first sighting of `(account_id,
 * signal_type, entity_ref)` inserts; a re-detection while an open row already
 * exists for that triple updates the evidence, score, reason and action on it
 * instead — main §7.9's "re-detection updates evidence and score on the open
 * row" — and `created` tells the caller which happened, for the run's own
 * `opportunities_created`/`opportunities_updated` counters (`signal_runs`).
 *
 * **Status is never touched on an update.** A merchant who has already
 * accepted, scheduled or is executing this opportunity should not have that
 * progress silently reset because the next scan re-measured the same signal —
 * only a fresh row (a first sighting) gets the status `buildOpportunityDraft`
 * assigned. Automatically un-blocking a `blocked` row once its precondition
 * clears is a real requirement of the same section ("re-evaluated
 * automatically") that this function deliberately does not attempt: that needs
 * the precondition re-checked, not merely the evidence re-measured, and no
 * card wires that check yet. See DECISIONS.
 */
export async function upsertOpportunity(
  db: Db,
  scope: AccountScope,
  draft: RankedOpportunityDraft,
  now: Date = new Date(),
): Promise<{ row: OpportunityRow; created: boolean }> {
  const [row] = await db
    .insert(opportunities)
    .values({
      accountId: scope.accountId,
      signalType: draft.signalType as OpportunityRow['signalType'],
      entityType: draft.entityType,
      entityRef: draft.entityRef,
      evidenceJson: draft.evidence,
      impact: draft.impact,
      impactScore: draft.impactScore,
      confidence: draft.confidence,
      reasonTemplateKey: draft.reasonTemplateKey,
      reasonParamsJson: draft.reasonParams,
      recommendedAction: LOWERCASE_ACTION[draft.recommendedAction],
      preconditionsJson: [...draft.preconditions],
      status: draft.status,
      rulesVersion: draft.rulesVersion,
      limitedIntelligence: draft.limitedIntelligence,
      detectedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [opportunities.accountId, opportunities.signalType, opportunities.entityRef],
      // Matches the partial index's own predicate, written the same way the
      // migration itself does (`packages/db/migrations/0002_wave2.sql`) —
      // Postgres only applies `ON CONFLICT` against a unique index whose
      // predicate the statement's `WHERE` clause is provably the same as.
      targetWhere: sql`${opportunities.status} IN ('new', 'accepted', 'scheduled', 'executing', 'blocked')`,
      set: {
        evidenceJson: sql`excluded.evidence_json`,
        impact: sql`excluded.impact`,
        impactScore: sql`excluded.impact_score`,
        confidence: sql`excluded.confidence`,
        reasonTemplateKey: sql`excluded.reason_template_key`,
        reasonParamsJson: sql`excluded.reason_params_json`,
        recommendedAction: sql`excluded.recommended_action`,
        preconditionsJson: sql`excluded.preconditions_json`,
        rulesVersion: sql`excluded.rules_version`,
        limitedIntelligence: sql`excluded.limited_intelligence`,
        updatedAt: sql`excluded.updated_at`,
      },
    })
    // `xmax = 0` is Postgres's own tell for "this row was just inserted, not
    // updated by this statement" — the cheapest way to answer "created or
    // updated" without a read before the write.
    .returning({
      id: opportunities.id,
      accountId: opportunities.accountId,
      signalType: opportunities.signalType,
      entityType: opportunities.entityType,
      entityRef: opportunities.entityRef,
      evidenceJson: opportunities.evidenceJson,
      impact: opportunities.impact,
      impactScore: opportunities.impactScore,
      confidence: opportunities.confidence,
      reasonTemplateKey: opportunities.reasonTemplateKey,
      reasonParamsJson: opportunities.reasonParamsJson,
      recommendedAction: opportunities.recommendedAction,
      preconditionsJson: opportunities.preconditionsJson,
      status: opportunities.status,
      topicId: opportunities.topicId,
      articleId: opportunities.articleId,
      limitedIntelligence: opportunities.limitedIntelligence,
      rulesVersion: opportunities.rulesVersion,
      detectedAt: opportunities.detectedAt,
      updatedAt: opportunities.updatedAt,
      expiredReason: opportunities.expiredReason,
      appliedAt: opportunities.appliedAt,
      outcomeJson: opportunities.outcomeJson,
      outcomeMeasuredAt: opportunities.outcomeMeasuredAt,
      created: sql<boolean>`(xmax = 0)`,
    })

  const { created, ...rest } = row as OpportunityRow & { created: boolean }
  return { row: rest, created }
}

export async function insertOpportunityTasks(
  db: Db,
  opportunityId: string,
  tasks: readonly OpportunityTaskDraft[],
): Promise<OpportunityTaskRow[]> {
  if (tasks.length === 0) return []
  return db
    .insert(opportunityTasks)
    .values(tasks.map((task) => ({ opportunityId, kind: task.kind, description: task.description })))
    .returning()
}

/**
 * Every open row this account has right now — the Opportunities screen's own
 * read, and what a re-ranking pass (`rankByImpact`, `packages/core`) needs to
 * rebuild each action family's comparison set.
 */
export async function listOpenOpportunities(db: Db, scope: AccountScope): Promise<OpportunityRow[]> {
  return db
    .select()
    .from(opportunities)
    .where(
      and(
        eq(opportunities.accountId, scope.accountId),
        inArray(opportunities.status, [...OPEN_OPPORTUNITY_STATUSES]),
      ),
    )
    .orderBy(desc(opportunities.impactScore), desc(opportunities.confidence))
}

/**
 * Auto-accepted CREATE/REFRESH opportunities — the frozen
 * `OpportunitySource.acceptedContentOpportunities` seam (`packages/core`
 * contracts) that Lane D's replenishment and calendar-seeding read. `label` on
 * the returned `EntityRef` is the raw `entity_ref` itself: this table holds no
 * richer display text (a page title, a keyword's own casing) to build one
 * from, so a caller wanting a nicer label resolves it from the entity's own
 * table.
 */
export async function acceptedContentOpportunities(
  db: Db,
  scope: AccountScope,
): Promise<OpportunityRow[]> {
  return db
    .select()
    .from(opportunities)
    .where(
      and(
        eq(opportunities.accountId, scope.accountId),
        eq(opportunities.status, 'accepted'),
        inArray(opportunities.recommendedAction, ['create', 'refresh']),
      ),
    )
    .orderBy(desc(opportunities.impactScore))
}

/**
 * Moves one opportunity from one of `from`'s statuses to `to` — the guarded
 * update every state transition in this product uses (invariant 15). A zero-row
 * result (`undefined`) means the row was not in an expected state: somebody
 * else already moved it, or the caller's own idea of the current status is
 * stale. Either way the caller stops rather than overwriting a decision it
 * did not make.
 */
export async function transitionOpportunityStatus(
  db: Db,
  scope: AccountScope,
  id: string,
  input: {
    readonly from: readonly OpportunityRow['status'][]
    readonly to: OpportunityRow['status']
  },
  now: Date = new Date(),
): Promise<OpportunityRow | undefined> {
  const [row] = await db
    .update(opportunities)
    .set({ status: input.to, updatedAt: now })
    .where(
      and(
        eq(opportunities.id, id),
        eq(opportunities.accountId, scope.accountId),
        inArray(opportunities.status, [...input.from]),
      ),
    )
    .returning()
  return row
}

/**
 * Expiry never deletes (invariant 10, main §7.9) — it stamps a reason and
 * leaves the row for the learning loop to read later. Any open status may
 * expire; `transitionOpportunityStatus`'s own guard covers the race.
 */
export async function expireOpportunity(
  db: Db,
  scope: AccountScope,
  id: string,
  reason: ExpiryReason,
  now: Date = new Date(),
): Promise<OpportunityRow | undefined> {
  const [row] = await db
    .update(opportunities)
    .set({ status: 'expired', expiredReason: reason, updatedAt: now })
    .where(
      and(
        eq(opportunities.id, id),
        eq(opportunities.accountId, scope.accountId),
        inArray(opportunities.status, [...OPEN_OPPORTUNITY_STATUSES]),
      ),
    )
    .returning()
  return row
}

/**
 * The user says no. Moves the row to `dismissed` and writes the not-interested
 * marker in the same call, so the two halves of main §7.9's rule — the row
 * leaves the open list, and the signal is never re-proposed — cannot come
 * apart. Keyed on `(signal_type, entity_ref)`, same as the dedupe index, so a
 * later detection of the same signal on the same entity is silently withheld
 * rather than reopening a conversation the merchant already ended — the
 * caller checking `dismissed_opportunities` before writing a new row is what
 * makes that true; this function only writes the marker.
 */
export async function dismissOpportunity(
  db: Db,
  scope: AccountScope,
  id: string,
  now: Date = new Date(),
): Promise<OpportunityRow | undefined> {
  const dismissed = await transitionOpportunityStatus(
    db,
    scope,
    id,
    { from: [...OPEN_OPPORTUNITY_STATUSES], to: 'dismissed' },
    now,
  )
  if (!dismissed) return undefined

  await db
    .insert(dismissedOpportunities)
    .values({
      accountId: scope.accountId,
      signalType: dismissed.signalType,
      entityRef: dismissed.entityRef,
      dismissedAt: now,
    })
    .onConflictDoUpdate({
      target: [dismissedOpportunities.accountId, dismissedOpportunities.signalType, dismissedOpportunities.entityRef],
      set: { dismissedAt: sql`excluded.dismissed_at` },
    })

  return dismissed
}

/** The not-interested list a "show dismissed" view reads, and what a new detection has to check before writing a fresh row for the same signal. */
export async function isDismissed(
  db: Db,
  scope: AccountScope,
  signalType: OpportunityRow['signalType'],
  entityRef: string,
): Promise<boolean> {
  const [row] = await db
    .select({ accountId: dismissedOpportunities.accountId })
    .from(dismissedOpportunities)
    .where(
      and(
        eq(dismissedOpportunities.accountId, scope.accountId),
        eq(dismissedOpportunities.signalType, signalType),
        eq(dismissedOpportunities.entityRef, entityRef),
      ),
    )
    .limit(1)
  return row !== undefined
}

/** Undoes a dismissal — the "show dismissed" view's own control (main §7.9) — back to `new` so the merchant sees it decided again rather than silently re-entering autopilot. */
export async function undismissOpportunity(
  db: Db,
  scope: AccountScope,
  id: string,
  now: Date = new Date(),
): Promise<OpportunityRow | undefined> {
  const row = await transitionOpportunityStatus(db, scope, id, { from: ['dismissed'], to: 'new' }, now)
  if (!row) return undefined
  await db
    .delete(dismissedOpportunities)
    .where(
      and(
        eq(dismissedOpportunities.accountId, scope.accountId),
        eq(dismissedOpportunities.signalType, row.signalType),
        eq(dismissedOpportunities.entityRef, row.entityRef),
      ),
    )
  return row
}

/**
 * The minimal opportunity-writing `T4.1`'s manual-add path needs, kept
 * alongside the Opportunity Engine's own writes above (`T3.6`, merged after
 * this) rather than folded into them — a manually-added topic's placeholder
 * row and a real detection's scored row are deliberately different shapes,
 * per `T3.6`'s own decision journal.
 *
 * `topics.opportunity_id` is `NOT NULL` with no hedge for manual topics
 * (`packages/db/src/schema/content-engine.ts`'s own comment on that column),
 * so a manually-added topic needs *an* opportunity row to point at before it
 * can be written at all. This is that row, kept as plain and as inert as the
 * FK requires: no real impact/confidence scoring (main §7.6's formula is
 * "internal and versioned", built by `T3.6` above) — `impact: 'low'` and
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
