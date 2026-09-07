import { assertCanTransition, type OpportunityStatus } from '@sortiva/core'

/**
 * The one thing every status write on an opportunity does before it touches a
 * row: ask whether the move is one the product actually allows.
 *
 * Each of those writes is a guarded update naming the statuses it is willing
 * to move a row out of, so the row can only ever travel from one of those to
 * the new one. Checking **every** status the guard names, rather than the one
 * the row turns out to be in, is what makes this a property of the code
 * instead of a property of the data: a move nobody drew is refused the first
 * time it is asked for, not the first time a row happens to be sitting in the
 * wrong place. It also means a caller cannot get an illegal move past this by
 * naming a wide set and hoping.
 *
 * It throws rather than returning false. A move nobody drew is a mistake in
 * the code asking for it, not a condition to recover from — performing it
 * quietly is exactly how the written lifecycle and the running product drifted
 * apart while nothing consulted the graph.
 */
export function assertMoveIsDrawn(
  from: readonly OpportunityStatus[],
  to: OpportunityStatus,
): void {
  for (const source of from) assertCanTransition(source, to)
}
