import type { ConflictCode } from '../api/errors'

/**
 * The calendar's state machine, main §8.7: `planned → generating →
 * in_review (if draft review enabled) → published | rejected_by_gate |
 * vetoed`. That chain is prose, not a strict diagram — §8.7's own text has
 * veto reachable from `planned` directly ("removing a `planned` topic is free
 * and instant") and from `generating` ("a veto arriving after that flip
 * cancels publication"), so `vetoed` is a fan-in from every state before the
 * three terminal ones, not only from `in_review`.
 *
 * `/api/calendar/topics/{topicId}/veto`'s frozen conflict list
 * (`packages/core/src/api/routes.ts`) names exactly one code —
 * `topic_already_published` — for this route. `rejected_by_gate` and
 * `vetoed` are, like `published`, already-resolved terminal states with no
 * veto action to take; there being no separate code for them is this card's
 * own reading of the frozen contract (DECISIONS 2026-09-03 T4.2), not a new
 * one invented here — the guard below reuses `topic_already_published` for
 * all three, rather than adding a code the frozen `CONFLICT_CODES` enum does
 * not have.
 */
export const VETOABLE_STATES = ['planned', 'generating', 'in_review'] as const
export type VetoableState = (typeof VETOABLE_STATES)[number]

export function isVetoable(state: string): state is VetoableState {
  return (VETOABLE_STATES as readonly string[]).includes(state)
}

/** Every veto attempt on a non-vetoable state answers with this one code — see the module comment. */
export const VETO_CONFLICT_CODE: ConflictCode = 'topic_already_published'

/**
 * Only a `planned` topic may be dragged or swapped — ui spec §6.1: "Drag any
 * `planned` topic". `generating`/`in_review`/`rejected_by_gate`/`vetoed` are
 * all mid-pipeline or resolved; `published` is the frozen contract's own
 * named case.
 */
export function isMovable(state: string): boolean {
  return state === 'planned'
}

/**
 * Which of the two "not planned" conflict codes a move should answer with,
 * for whichever topic (the one being dragged, or the occupant it would swap
 * with) turns out not to be movable. `topic_already_generating` when the race
 * is the one the lock-semantics section is actually about (the daily job
 * dequeued it under us); `topic_already_published` for every other
 * already-resolved state, on the same reasoning as the veto guard above —
 * the frozen contract names only these two codes for this route.
 */
export function moveConflictCodeFor(actualState: string): ConflictCode {
  return actualState === 'generating' ? 'topic_already_generating' : 'topic_already_published'
}

/**
 * Pin/unpin's frozen conflict list also names exactly one code. Applied
 * uniformly: pinning is refused only once a topic has actually published.
 */
export function isPinnable(state: string): boolean {
  return state !== 'published'
}

export const PIN_CONFLICT_CODE: ConflictCode = 'topic_already_published'
