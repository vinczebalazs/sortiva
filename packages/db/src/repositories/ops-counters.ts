import { and, desc, eq, gte, ne } from 'drizzle-orm'
import { OVERRIDE_GATE_OUTCOME, type Gate3Outcome } from '@sortiva/core'
import type { Db } from '../client'
import { gateDecisions, publishAttempts } from '../schema'
import type { SystemScope } from '../scope'

/**
 * What the automatic brakes count, read from the tables the product actually
 * writes.
 *
 * A file of its own rather than more of `gate-decisions.ts`, which belongs to
 * the content engine: these reads exist for the operations sweep, they are
 * deliberately unscoped where every content read is per-store, and a new file
 * cannot collide with a lane appending to an old one.
 */

/**
 * The pass. Typed rather than written as a bare string so that renaming the
 * gate's own vocabulary breaks the build here instead of silently turning every
 * pass into a rejection — which would read as a total quality collapse and stop
 * the whole product.
 */
const PASSED: Gate3Outcome = 'passed'

/** How the last few drafts fared at the quality gate, across every store. */
export interface Gate3OutcomeCounts {
  /** Drafts the gate refused. */
  readonly rejected: number
  /** Drafts it looked at at all. Never larger than the number asked for. */
  readonly graded: number
}

/**
 * The last `trailingDrafts` quality-gate decisions, and how many of them were
 * refusals.
 *
 * **Deliberately across all accounts**, unlike every content read beside it: the
 * ceiling this feeds is about the product as a whole, and one busy store's bad
 * afternoon is exactly what it must not mistake for a broken prompt.
 *
 * A merchant's "publish anyway" writes a second gate-3 row saying they overruled
 * us. It grades nothing, so it is excluded here — counting it as a pass would
 * hide the refusal it sits on top of, and counting it as a rejection would count
 * the same draft twice. The refusal itself stays: the judge really did reject
 * that draft, whatever the merchant did next.
 *
 * A row that is neither the override marker nor a pass counts as a refusal.
 * Rejections have several names (a failed lint, a contradiction, a judge score
 * under the floor, a failed repair) and more can be added; passes have exactly
 * one. Reading an unfamiliar outcome as a refusal errs towards pausing, which an
 * operator sees within minutes, rather than towards a brake that never fires,
 * which is the failure this whole seam was built around.
 */
export async function recentGate3Outcomes(
  db: Db,
  _scope: SystemScope,
  trailingDrafts: number,
): Promise<Gate3OutcomeCounts> {
  const rows = await db
    .select({ outcome: gateDecisions.outcome })
    .from(gateDecisions)
    .where(and(eq(gateDecisions.gate, 3), ne(gateDecisions.outcome, OVERRIDE_GATE_OUTCOME)))
    .orderBy(desc(gateDecisions.decidedAt))
    .limit(trailingDrafts)

  return {
    graded: rows.length,
    rejected: rows.filter((row) => row.outcome !== PASSED).length,
  }
}

/** How publishing to merchants' shops has gone lately, across every store. */
export interface PublishOutcomeCounts {
  /** Attempts the shop turned away, plus the ones we finally gave up on. */
  readonly failed: number
  /** Every attempt in the window, whatever it ended as. */
  readonly attempted: number
}

/**
 * Every attempt to post an article since `since`, and how many of them failed.
 *
 * **Deliberately across all accounts**, like the gate counter above: the switch
 * this feeds stops publishing for everybody, so the question is whether the
 * platform is having a bad day, not whether one store is.
 *
 * **An attempt we could not judge is not a failure.** When a connection breaks
 * mid-post, the article may be on the merchant's blog right now; counted as a
 * failure, a flaky network would raise the same switch a genuine outage does.
 * It stays in the total, because it really was an attempt and hiding it would
 * make a bad hour look smaller than it was — so a spell of uncertainty can only
 * ever make this brake slower to fire, never quicker.
 *
 * A shop that gave up on us and a shop that refused us are both failures: the
 * article did not go out either way, and it is the refusals that carry the
 * shape of an outage.
 */
export async function recentPublishOutcomes(
  db: Db,
  _scope: SystemScope,
  since: Date,
): Promise<PublishOutcomeCounts> {
  const rows = await db
    .select({ outcome: publishAttempts.outcome })
    .from(publishAttempts)
    .where(gte(publishAttempts.endedAt, since))

  return {
    attempted: rows.length,
    failed: rows.filter((row) => row.outcome === 'refused' || row.outcome === 'abandoned').length,
  }
}
