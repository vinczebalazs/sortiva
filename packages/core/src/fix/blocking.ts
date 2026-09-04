import { normalisePageUrl } from '../signals/types'

/**
 * A technical obstacle on a page comes before anything we would write for it.
 *
 * If Google is not indexing a collection, or is treating a different address as
 * the real version of it, then better copy on that collection cannot help: the
 * page it would improve is not the page being shown. So while such a problem is
 * open on a page, any suggestion to create or improve that page is shown as
 * **blocked** rather than removed. That distinction is the whole point — a
 * merchant who sees nothing assumes there is nothing to do, and a merchant who
 * sees "blocked: this page is not indexed" knows what to fix first.
 *
 * Not every FIX blocks. The store competing with itself for one search is a FIX
 * too, and it is editorial work on a group of pages rather than an obstacle on
 * one of them — improving any of those pages is still worth doing while it is
 * open, so it blocks nothing.
 */

/**
 * The signal types whose open FIX rows block content work on the same page.
 * One entry today: it covers both "Google is not indexing this" and "Google has
 * picked a different address as the real one", which are the two obstacles a
 * page can carry that make writing for it pointless.
 */
export const BLOCKING_FIX_SIGNAL_TYPES: readonly string[] = ['indexing_issue']

/** The actions a blocking FIX stops. A FIX never blocks another FIX, and a HOLD is already blocked by its own precondition. */
const BLOCKABLE_ACTIONS: readonly string[] = ['create', 'optimize', 'CREATE', 'OPTIMIZE']

/** The shape this module needs from an opportunity row, whatever else the row carries. */
export interface BlockingCandidateRow {
  readonly signalType: string
  readonly entityRef: string
  readonly recommendedAction: string
  readonly status: string
}

const OPEN_STATUSES: readonly string[] = ['new', 'accepted', 'scheduled', 'executing', 'blocked']

function isOpen(row: BlockingCandidateRow): boolean {
  return OPEN_STATUSES.includes(row.status)
}

function isBlockingFix(row: BlockingCandidateRow): boolean {
  return (
    isOpen(row) &&
    row.recommendedAction.toLowerCase() === 'fix' &&
    BLOCKING_FIX_SIGNAL_TYPES.includes(row.signalType)
  )
}

/**
 * Which entity refs currently carry a blocking obstacle, and which signal it
 * is. The signal type is the precondition key the blocked row stores, so the
 * card can say what is in the way rather than only that something is.
 */
export function blockingFixesByEntity(
  open: readonly BlockingCandidateRow[],
): ReadonlyMap<string, string> {
  const out = new Map<string, string>()
  for (const row of open) {
    if (isBlockingFix(row)) out.set(normalisePageUrl(row.entityRef), row.signalType)
  }
  return out
}

/**
 * The precondition keys a CREATE or OPTIMIZE on this entity should be carrying,
 * given everything currently open for the account. Empty means nothing is in
 * the way.
 *
 * Kept separate from detection deliberately: the weekly scan applies this when
 * it re-measures a signal, and the merchant-initiated path applies it again at
 * the moment of the press, because a blocker can appear between the two and the
 * press is what spends the store's money.
 */
export function blockingPreconditionsFor(
  entityRef: string,
  recommendedAction: string,
  open: readonly BlockingCandidateRow[],
): readonly string[] {
  if (!BLOCKABLE_ACTIONS.includes(recommendedAction)) return []
  const blocker = blockingFixesByEntity(open).get(normalisePageUrl(entityRef))
  return blocker ? [blocker] : []
}
