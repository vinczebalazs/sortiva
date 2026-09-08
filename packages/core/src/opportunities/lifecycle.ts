import type { OpportunityAction, OpportunityStatus } from '../contracts/opportunities'

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
 *
 * Two lifecycles share these statuses and only one of them passes through
 * `scheduled`. A CREATE/REFRESH is given a calendar topic and the calendar
 * starts it. An OPTIMIZE is never given a topic: the merchant presses "improve
 * this page" on a row sitting at `new` or `accepted`, a recommendation is
 * written, and the row goes back to waiting on them. Written around the
 * calendar alone, this graph made the merchant-initiated path illegal on paper
 * while the code performed it every time; the graph was the half that was
 * wrong, and these edges are what it was missing.
 *
 * `completed` is reachable from every open status because the move into it is
 * the merchant saying they applied the recommendation, and that answer is
 * legitimate whatever the row happened to be doing when they gave it. The
 * repository's own guard for that move is "still open" and this mirrors it, so
 * the two cannot disagree.
 *
 * Every status write now asks this graph first and an undrawn move throws, so
 * a missing edge stops a working feature instead of sitting quietly in a
 * document. Each edge below is therefore drawn from the guard that actually
 * performs the move rather than from an idea of how the lifecycle ought to
 * run: where a guard says "any status the row is still open in", so does this.
 */
const ALLOWED: Readonly<Record<OpportunityStatus, readonly OpportunityStatus[]>> = {
  new: ['accepted', 'executing', 'completed', 'blocked', 'dismissed', 'expired'],
  // A resolved precondition returns a blocked row to `new`; only CREATE/REFRESH
  // auto-accept at detection time (`initialStatus` in `build.ts`), so a
  // formerly-blocked CREATE/REFRESH goes back through `accepted`, not `new` —
  // callers pick which by naming the row's `recommendedAction`, this graph
  // only says the edge exists.
  accepted: ['scheduled', 'executing', 'completed', 'blocked', 'dismissed', 'expired'],
  // Back to `accepted` because a claim can be given up. Replenishment marks a
  // candidate as taken *before* it tries to put it on a calendar day, so that a
  // crash between the two costs one candidate rather than producing two
  // articles on one subject; when the placement is refused, the mark it made a
  // moment earlier has to come off again.
  scheduled: ['accepted', 'executing', 'completed', 'blocked', 'dismissed', 'expired'],
  // Finishing the work is not the merchant having acted on it, so generation
  // ends back at `accepted` rather than at `completed`. A recommendation that
  // failed our own quality checks lands in the same place, which is what keeps
  // the row theirs to press again instead of stranding it mid-flight.
  //
  // Back to `new` for the same reason `scheduled` goes back to `accepted`:
  // pressing "improve this page" marks the row as being worked on before the
  // work is queued, and if queueing fails the row is put back exactly where it
  // was — which, for a row nobody had touched yet, is `new`.
  //
  // To `dismissed` because a merchant may say "not interested" about something
  // we are in the middle of doing, and their answer is not made to wait for us.
  // The call we have already paid for is ours to absorb.
  executing: ['new', 'accepted', 'completed', 'blocked', 'dismissed', 'expired'],
  blocked: ['new', 'accepted', 'completed', 'dismissed', 'expired'],
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
 * What re-detection should do about a row's status when this pass's fresh
 * preconditions disagree with what the stored row already says — closing the
 * gap `T3.6`'s scheduled audit found (HIGH, 2026-09-03): `upsertOpportunity`
 * deliberately never touches `status` on an update, which protects a
 * merchant's in-progress work from being reset backward, but also means a
 * technical blocker discovered *after* a CREATE/REFRESH auto-accepted never
 * actually re-blocks it — `acceptedContentOpportunities()`, the exact seam
 * Lane D's replenishment and calendar-seeding read, keeps returning a row that
 * should no longer be offered.
 *
 * Deliberately narrow. Only `new`, `accepted` and `blocked` are considered:
 * `scheduled`/`executing` are the calendar's own territory (`topics`' state
 * machine, Lane D, `T4.2`) the instant a topic exists for the row, and a
 * signal-detection pass reaching past that into a topic already placed or
 * generating is exactly the kind of cross-lane reach this card's directories
 * do not extend to. So this closes the gap for the window that matters most —
 * before Lane D ever sees the row — and leaves the rest of the merchant's
 * progress exactly where `T3.6` left it. See DECISIONS 2026-09-03 T3.7.
 *
 * Also completes the promise `T3.6`'s own journal named but did not build:
 * main §7.9's "blocked — re-evaluated automatically" and the HOLD view's own
 * copy ("we'll re-check automatically after your next scan") are honoured in
 * the same pass, symmetrically — a row whose precondition has cleared moves
 * back out of `blocked`, using the same edge `T3.6`'s lifecycle graph already
 * allows.
 */
export function reconcileStatusWithPreconditions(
  current: OpportunityStatus,
  action: OpportunityAction,
  preconditionsNowEmpty: boolean,
): { readonly to: OpportunityStatus } | null {
  if ((current === 'new' || current === 'accepted') && !preconditionsNowEmpty) {
    return { to: 'blocked' }
  }
  if (current === 'blocked' && preconditionsNowEmpty) {
    return { to: action === 'CREATE' || action === 'REFRESH' ? 'accepted' : 'new' }
  }
  return null
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
  /**
   * The merchant did the work. A held opportunity waits on product detail only
   * they can supply, and this is the one reason a row leaves the open set
   * because a person acted rather than because a measurement moved: the
   * products behind the search now clear the substance floor. It is a reason of
   * its own precisely so the Products screen can fold the checklist away as
   * finished without also congratulating a merchant for a keyword quietly
   * losing its search volume.
   */
  'catalog_now_sufficient',
] as const
export type ExpiryReason = (typeof EXPIRY_REASONS)[number]
