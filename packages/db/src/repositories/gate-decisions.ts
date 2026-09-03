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
