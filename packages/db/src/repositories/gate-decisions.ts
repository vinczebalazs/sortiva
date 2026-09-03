import { and, desc, eq, inArray } from 'drizzle-orm'
import type { Db } from '../client'
import { gateDecisions } from '../schema'
import type { AccountScope } from '../scope'

export type GateDecisionRow = typeof gateDecisions.$inferSelect

/**
 * One row of `gate_decisions` — main §13, the audit trail main §8.5 asks for
 * ("log every gate decision with scores and justifications to audit drift").
 *
 * `outcome` is free text by T4.0's own decision (DECISIONS 2026-09-03 T4.0);
 * the exact strings Gate 1 writes are `Gate1OutcomeKind`
 * (`packages/core/src/gates/gate1.ts`). `reasonUserFacing` holds the reason
 * card's *template key* rather than rendered prose — see DECISIONS
 * 2026-09-03 T4.1 — with the interpolation params, retry condition and
 * redirect (none of which this table has a column for) folded into
 * `scoresJson` instead. Gate 1 makes no model call, so `promptVersion` and
 * `modelId` are always null here, matching the column comments already on
 * the table.
 */
export interface GateDecisionInput {
  readonly topicId: string
  readonly gate: 1 | 2 | 3
  readonly outcome: string
  readonly scoresJson: unknown
  readonly reasonUserFacing: string | null
}

export async function insertGateDecision(
  db: Db,
  scope: AccountScope,
  input: GateDecisionInput,
  now: Date = new Date(),
): Promise<GateDecisionRow> {
  const [row] = await db
    .insert(gateDecisions)
    .values({
      accountId: scope.accountId,
      topicId: input.topicId,
      gate: input.gate,
      outcome: input.outcome,
      scoresJson: input.scoresJson as never,
      reasonUserFacing: input.reasonUserFacing,
      promptVersion: null,
      modelId: null,
      decidedAt: now,
    })
    .returning()
  if (!row) throw new Error('failed to insert the gate decision')
  return row
}

/**
 * The most recent decision on this topic for one of the given gates —
 * `GET /api/calendar`'s `rejection` field reads this for a
 * `rejected_by_gate` day, main §8.6's "which gate, plain-language reason".
 */
export async function findLatestGateDecisionForTopic(
  db: Db,
  scope: AccountScope,
  topicId: string,
  gates: readonly (1 | 2 | 3)[] = [1, 2, 3],
): Promise<GateDecisionRow | undefined> {
  const [row] = await db
    .select()
    .from(gateDecisions)
    .where(
      and(
        eq(gateDecisions.accountId, scope.accountId),
        eq(gateDecisions.topicId, topicId),
        inArray(gateDecisions.gate, [...gates]),
      ),
    )
    .orderBy(desc(gateDecisions.decidedAt))
    .limit(1)
  return row
}

/** Bulk variant for the calendar list — every topic's latest decision in one query rather than one per topic. */
export async function latestGateDecisionsForTopics(
  db: Db,
  scope: AccountScope,
  topicIds: readonly string[],
): Promise<Map<string, GateDecisionRow>> {
  if (topicIds.length === 0) return new Map()
  const rows = await db
    .select()
    .from(gateDecisions)
    .where(and(eq(gateDecisions.accountId, scope.accountId), inArray(gateDecisions.topicId, [...topicIds])))
    .orderBy(desc(gateDecisions.decidedAt))

  const latest = new Map<string, GateDecisionRow>()
  for (const row of rows) {
    if (!latest.has(row.topicId)) latest.set(row.topicId, row)
  }
  return latest
}
