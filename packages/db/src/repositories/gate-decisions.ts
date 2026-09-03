import { and, desc, eq, gte, inArray, notInArray } from 'drizzle-orm'
import type { Db } from '../client'
import { articles, gateDecisions } from '../schema'
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
 * `scoresJson` instead. Gate 1 makes no model call, so it passes neither
 * `promptVersion` nor `modelId` and they stay null, matching the column
 * comments already on the table. Gate 3 does make one and passes both:
 * without them a stored score cannot be attributed to the prompt and model
 * that produced it, which is the entire reason main §8.5 asks for this table.
 */
export interface GateDecisionInput {
  readonly topicId: string
  readonly gate: 1 | 2 | 3
  readonly outcome: string
  readonly scoresJson: unknown
  readonly reasonUserFacing: string | null
  readonly promptVersion?: string | null
  readonly modelId?: string | null
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
      promptVersion: input.promptVersion ?? null,
      modelId: input.modelId ?? null,
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

/**
 * The calibration set — main §8.5: the gate decisions the quality bar is tuned
 * against, sampled to see whether the judge is drifting across model and
 * prompt changes.
 *
 * **Override-published articles are excluded here, at the query.** An article
 * a merchant published after we said it was not good enough cannot be evidence
 * about whether our judgement was right; leaving it in would let a store that
 * overrides everything quietly loosen the bar for everyone. Invariant 12, main
 * §8.6. The exclusion lives in this function rather than in each caller so
 * there is one place it can be got wrong, and one test that proves it is not.
 *
 * Scoped per account like every other repository read, so sampling across
 * stores means asking for each store rather than reaching across all of them
 * from one query.
 */
export async function gateDecisionsForCalibration(
  db: Db,
  scope: AccountScope,
  options: { readonly since?: Date; readonly limit?: number } = {},
): Promise<GateDecisionRow[]> {
  const overridden = db
    .select({ topicId: articles.topicId })
    .from(articles)
    .where(and(eq(articles.accountId, scope.accountId), eq(articles.publishedViaOverride, true)))

  const conditions = [
    eq(gateDecisions.accountId, scope.accountId),
    eq(gateDecisions.gate, 3),
    notInArray(gateDecisions.topicId, overridden),
  ]
  if (options.since) conditions.push(gte(gateDecisions.decidedAt, options.since))

  return db
    .select()
    .from(gateDecisions)
    .where(and(...conditions))
    .orderBy(desc(gateDecisions.decidedAt))
    .limit(options.limit ?? 500)
}
