import type { DriftKind } from './drift'
import type { RepairRoute } from './routing'

/**
 * The record of what a repair actually changed.
 *
 * Main §14.1 asks for repairs to be logged per article with before and after,
 * and the article screen shows a "repaired" badge that links to it. There is no
 * repairs table in the schema and this card may not add one, so the record
 * lives on the repair itself: every repair *is* an opportunity row, those rows
 * are never deleted, and one carries a free-form outcome. An article's repair
 * history is therefore the finished repair rows that name it — in order, with
 * what each one did.
 *
 * Namespaced under one key rather than written at the top level so that the
 * learning loop, when it eventually measures outcomes on the same rows, has
 * somewhere of its own to write and neither overwrites the other.
 */

export const REPAIR_OUTCOME_KEY = 'repair'

/** One reference, before and after. Titles as well as ids, so the log reads without joins. */
export interface RepairedReference {
  readonly placeholderKey: string
  readonly fromProductId: string | null
  readonly fromProductTitle: string
  readonly toProductId: string
  readonly toProductTitle: string
  /** How much of the withdrawn product's fact sheet the stand-in carries, 0–1. */
  readonly overlap: number
}

export interface RepairRecord {
  readonly kind: DriftKind
  readonly route: RepairRoute
  readonly repairedAt: string
  readonly references: readonly RepairedReference[]
  /** The revision of the published article this produced, where one was posted. */
  readonly revisionN?: number
  /** Set when the repair could not be completed, so a finished row is never mistaken for a mended page. */
  readonly failed?: string
}

export function repairOutcome(record: RepairRecord): Record<string, unknown> {
  return { [REPAIR_OUTCOME_KEY]: record }
}

/** Reads a repair back out of an opportunity's outcome, ignoring anything else written beside it. */
export function readRepairOutcome(outcome: unknown): RepairRecord | undefined {
  if (!outcome || typeof outcome !== 'object') return undefined
  const record = (outcome as Record<string, unknown>)[REPAIR_OUTCOME_KEY]
  if (!record || typeof record !== 'object') return undefined
  return record as RepairRecord
}
