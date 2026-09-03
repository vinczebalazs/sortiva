import type { OpportunityStatus } from '../contracts/opportunities'

/**
 * The status machine main §7.9 draws in prose, as a graph a caller can check
 * before it ever reaches the database. The database transition itself is
 * still a guarded `UPDATE ... WHERE status = expected` (invariant 15 — the
 * same discipline every job step in this product uses, main §14.3.1) because
 * two workers racing to move the same row is a real possibility this graph
 * alone cannot rule out; this module is what decides *whether* a move is
 * legal at all, so that check can live in one place instead of being
 * re-derived at every call site.
 *
 * `completed` has no outgoing edge: main §7.9 never describes reopening a
 * finished opportunity, and the learning loop needs a completed row to stay
 * exactly what it was when it finished. `expired` likewise never deletes and
 * never reopens — a signal detected again after expiry is a **new** row (the
 * partial unique index only covers the statuses below, so an expired row
 * cannot block one), not a revival of the old one.
 */
const ALLOWED: Readonly<Record<OpportunityStatus, readonly OpportunityStatus[]>> = {
  new: ['accepted', 'blocked', 'dismissed', 'expired'],
  // A resolved precondition returns a blocked row to `new`; only CREATE/REFRESH
  // auto-accept at detection time (`initialStatus` in `build.ts`), so a
  // formerly-blocked CREATE/REFRESH goes back through `accepted`, not `new` —
  // callers pick which by naming the row's `recommendedAction`, this graph
  // only says the edge exists.
  accepted: ['scheduled', 'blocked', 'dismissed', 'expired'],
  scheduled: ['executing', 'blocked', 'dismissed', 'expired'],
  executing: ['completed', 'blocked', 'expired'],
  blocked: ['new', 'accepted', 'dismissed', 'expired'],
  // The not-interested list keeps a dismissed signal from ever being
  // re-proposed (main §7.9), but the same section's "show dismissed" view
  // lets the merchant undo one — back to `new`, never straight to `accepted`,
  // so an undone CREATE still gets one more look before it auto-schedules.
  dismissed: ['new'],
  completed: [],
  expired: [],
}

export function canTransition(from: OpportunityStatus, to: OpportunityStatus): boolean {
  return ALLOWED[from].includes(to)
}

export function allowedTransitionsFrom(status: OpportunityStatus): readonly OpportunityStatus[] {
  return ALLOWED[status]
}

export class InvalidOpportunityTransitionError extends Error {
  constructor(
    readonly from: OpportunityStatus,
    readonly to: OpportunityStatus,
  ) {
    super(`Cannot move an opportunity from "${from}" to "${to}".`)
    this.name = 'InvalidOpportunityTransitionError'
  }
}

/** Throws rather than returning a boolean, matching `assertClearedToCreate`'s posture: there is no sensible way to carry on with an illegal move. */
export function assertCanTransition(from: OpportunityStatus, to: OpportunityStatus): void {
  if (!canTransition(from, to)) throw new InvalidOpportunityTransitionError(from, to)
}

/**
 * Every reason a row can leave the open set without a person acting —
 * main §7.9's own list, named so the repository stamps one rather than a free
 * string.
 */
export const EXPIRY_REASONS = [
  /** Search Console shows an improved position that no longer meets the signal's own band — the page moved to #2. */
  'evidence_no_longer_holds',
  /** The keyword this opportunity was about fell under the demand floor at the next scan. */
  'demand_lost',
  /** The product or page the opportunity was about no longer exists. */
  'entity_deleted',
  /** A newer detection of the same signal on the same entity superseded this row before it was acted on. */
  'superseded',
] as const
export type ExpiryReason = (typeof EXPIRY_REASONS)[number]
