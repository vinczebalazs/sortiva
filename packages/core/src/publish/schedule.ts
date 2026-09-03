import type { LifecycleGate } from '../lifecycle/gate'

/**
 * When a finished article is handed over, and whether it may be.
 *
 * An article does not appear the instant the quality gate passes it. It appears
 * at the store's own publish hour — nine in the morning where the *audience*
 * is, by default, which for a German shop run from Bali is nine in Berlin. Two
 * reasons: the merchant knows when to expect it, and at one a day publication
 * stays paced rather than arriving in bursts that read as machine output.
 *
 * That pacing is also why at most one article is handed over per pass. A
 * merchant who approves three drafts at once has three days of publishing
 * ahead, not one morning of it.
 *
 * The reasons to stop are the same ones, in the same order, as the ones that
 * stop the day's writing — an operator brake, then whether the merchant is paid
 * up, then whether they are away. Delivery is a write, so billing gates it;
 * reading what has already been written never is.
 */

export type DeliveryBlockReason =
  /** An operator brake, or one the spend meter raised. */
  | 'paused'
  /** The switches could not be read at all, which is treated as "stop". */
  | 'switches_unreadable'
  /** Deletion has been requested; the account is on its way out. */
  | 'deleted'
  /** Not paid up. Publishing stops; every article already delivered stays readable. */
  | 'not_entitled'
  /** The merchant is away. */
  | 'vacation'
  /** Nothing is finished and waiting. */
  | 'nothing_ready'

export type DeliveryDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: DeliveryBlockReason; readonly flag?: string }

export interface DeliveryInput {
  readonly switches:
    | { readonly allowed: true }
    | { readonly allowed: false; readonly reason: 'paused'; readonly flag: string }
    | { readonly allowed: false; readonly reason: 'unreadable'; readonly detail: string }
  readonly lifecycle: LifecycleGate
  /** True when at least one article has been graded, cleared and is waiting for its hour. */
  readonly hasArticleReady: boolean
}

export function decideDelivery(input: DeliveryInput): DeliveryDecision {
  if (!input.switches.allowed) {
    return input.switches.reason === 'paused'
      ? { allowed: false, reason: 'paused', flag: input.switches.flag }
      : { allowed: false, reason: 'switches_unreadable' }
  }

  for (const stop of input.lifecycle.stoppedBy) {
    if (stop === 'deletion_requested') return { allowed: false, reason: 'deleted' }
    if (stop === 'billing') return { allowed: false, reason: 'not_entitled' }
    if (stop === 'vacation') return { allowed: false, reason: 'vacation' }
  }

  if (!input.hasArticleReady) return { allowed: false, reason: 'nothing_ready' }

  return { allowed: true }
}

/**
 * Whether this hour, on the store's own clock, is the hour its article is due.
 *
 * Trivial on its own, and here rather than inline because it is the sentence
 * the whole delivery schedule turns on: the hour compared is the store's, never
 * the server's.
 */
export function isPublishHour(localHour: number, publishHour: number): boolean {
  return localHour === publishHour
}
