import { and, desc, eq, gte, inArray, lt, ne, notInArray } from 'drizzle-orm'
import { OVERRIDE_GATE_OUTCOME } from '@sortiva/core'
import type { Db } from '../client'
import { articles, gateDecisions, topics } from '../schema'
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
  /**
   * The resolved threshold version the gate judged under — the base hash with
   * this store's own overrides folded in, not the global one. Required rather
   * than optional: a decision with no record of the bar it was held to cannot
   * be re-read later, and every caller already has the value in hand.
   */
  readonly rulesVersion: string
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
      rulesVersion: input.rulesVersion,
      decidedAt: now,
    })
    .returning()
  if (!row) throw new Error('failed to insert the gate decision')
  return row
}

/**
 * The values that fill the blanks in a rejection's sentence — which criteria
 * the draft failed, the grader's own written objection, where a lint tripped.
 *
 * The table has no column for them. `reason_user_facing` holds the key of the
 * sentence and nothing else, and the gate folds the values it measured into
 * `scores_json` beside its audit trail, so reading them back means knowing a
 * shape only this table knows. That knowledge lives here rather than in each
 * screen that asks — which is how it came to be missing from the calendar for
 * the life of the feature: the row held the values, the response sent an empty
 * bag, and the sentence rendered with its blanks unfilled.
 *
 * Anything that is not a string or a number is dropped rather than coerced. A
 * nested object pushed into a merchant's sentence reads as `[object Object]`,
 * which is worse than the blank it would replace.
 */
export function reasonParamsOf(
  row: GateDecisionRow | null | undefined,
): Readonly<Record<string, string | number>> {
  const scores = row?.scoresJson
  if (typeof scores !== 'object' || scores === null) return {}
  const stored = (scores as Record<string, unknown>).reason_params
  if (typeof stored !== 'object' || stored === null) return {}

  const params: Record<string, string | number> = {}
  for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
    if (typeof value === 'string' || typeof value === 'number') params[key] = value
  }
  return params
}

/**
 * The most recent decision on this topic for one of the given gates.
 *
 * **This is the wrong function for anything that means "the decision that
 * judged the draft".** Once a merchant publishes over a rejection there is a
 * second gate-3 row on the topic recording that they overruled us, and it is
 * the more recent one; ask `gate3DecisionsForTopic` instead, which keeps the
 * two apart by name.
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

/**
 * The two gate-3 rows that say different things about the same draft.
 *
 * `grading` is the decision that judged the words: the per-criterion scores,
 * the judge's own written objections, and the grader that produced them.
 * `override` is the row a merchant's "publish anyway" writes on top of it — it
 * records that they overruled us and what the confirmation restated to them,
 * and it judges nothing.
 *
 * They are separated here rather than at each call site because "the most
 * recent gate-3 decision" quietly stops meaning "the one that graded the
 * draft" the moment an override exists, and a screen asking the first question
 * would be handed the second — showing a merchant who overruled us numbers
 * with none of the sentences that explain them.
 */
export interface Gate3DecisionsForTopic {
  readonly grading: GateDecisionRow | undefined
  readonly override: GateDecisionRow | undefined
}

export async function gate3DecisionsForTopic(
  db: Db,
  scope: AccountScope,
  topicId: string,
): Promise<Gate3DecisionsForTopic> {
  const rows = await db
    .select()
    .from(gateDecisions)
    .where(
      and(
        eq(gateDecisions.accountId, scope.accountId),
        eq(gateDecisions.topicId, topicId),
        eq(gateDecisions.gate, 3),
      ),
    )
    .orderBy(desc(gateDecisions.decidedAt))

  return {
    grading: rows.find((row) => row.outcome !== OVERRIDE_GATE_OUTCOME),
    override: rows.find((row) => row.outcome === OVERRIDE_GATE_OUTCOME),
  }
}

/**
 * What stopped each of these topics, in one query rather than one per topic —
 * the calendar's `rejection` field for a held day: which gate, and the key of
 * the plain-language reason it recorded.
 *
 * An override row is skipped. It is a record of a merchant overruling us, not
 * of anything being judged, and it carries no reason of its own — so taking it
 * as the topic's latest decision left the calendar with nothing to say and
 * falling back to a stock Gate 1 line about a draft Gate 3 had actually read.
 */
export async function latestGateDecisionsForTopics(
  db: Db,
  scope: AccountScope,
  topicIds: readonly string[],
): Promise<Map<string, GateDecisionRow>> {
  if (topicIds.length === 0) return new Map()
  const rows = await db
    .select()
    .from(gateDecisions)
    .where(
      and(
        eq(gateDecisions.accountId, scope.accountId),
        inArray(gateDecisions.topicId, [...topicIds]),
        ne(gateDecisions.outcome, OVERRIDE_GATE_OUTCOME),
      ),
    )
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

/** A topic the quality bar stopped, and which gate stopped it. */
export interface HeldBackTopicRow {
  readonly topicId: string
  readonly title: string
  readonly gate: number
}

/**
 * What the quality bar held back in a month, for the monthly summary — main
 * §8.6: "5 topics were held back by our quality bar — here's each one and why."
 *
 * The decision row is not on its own enough to say a topic was held: a gate
 * writes a row when it passes a topic too. What settles it is the topic's own
 * state, so this asks both questions — a decision inside the month, on a topic
 * that ended up rejected. The latest such decision per topic wins, because a
 * topic can be looked at by more than one gate and it is the one that stopped
 * it that has the reason.
 */
export async function heldBackTopicsInMonth(
  db: Db,
  scope: AccountScope,
  window: { from: Date; to: Date },
  limit = 25,
): Promise<readonly HeldBackTopicRow[]> {
  const rows = await db
    .select({ topicId: topics.id, title: topics.title, gate: gateDecisions.gate })
    .from(gateDecisions)
    .innerJoin(topics, eq(gateDecisions.topicId, topics.id))
    .where(
      and(
        eq(gateDecisions.accountId, scope.accountId),
        eq(topics.state, 'rejected_by_gate'),
        gte(gateDecisions.decidedAt, window.from),
        lt(gateDecisions.decidedAt, window.to),
      ),
    )
    .orderBy(desc(gateDecisions.decidedAt))

  const held = new Map<string, HeldBackTopicRow>()
  for (const row of rows) if (!held.has(row.topicId)) held.set(row.topicId, row)
  return [...held.values()].slice(0, limit)
}
