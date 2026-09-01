/**
 * The user-facing strings of the domain claim, in one module with a snapshot
 * test on them — the same treatment T1.2 gave the billing copy, and for the
 * same reason: `packages/ui/strings/*.json` does not exist yet and belongs to
 * another lane. See DECISIONS 2026-08-31 T1.2.
 */

/**
 * main §5, verbatim: "Already claimed by another account → error: 'This domain
 * is already connected to another account. If you believe this is a mistake,
 * contact support.'" ui §3.1 renders it inline under the URL input, with a
 * support link. Support-mediated transfer; no self-serve domain stealing.
 */
export const DOMAIN_ALREADY_CLAIMED_MESSAGE =
  'This domain is already connected to another account. If you believe this is a mistake, contact support.'

/**
 * Invariant 1's other half — one domain per account — has no string in the
 * spec, because main §4.3 only ever shows the connect box to an account with
 * `domain = null`. This answers the paths that reach the route anyway: a stale
 * tab, a second browser, a direct API call. Copy invented by T1.4 and awaiting
 * founder sign-off; the transfer posture is main §5's (support-mediated).
 */
export function accountHasOtherDomainMessage(current: string): string {
  return `This account is already connected to ${current}. An account connects one domain — contact support if you need to change it.`
}

/** ui §3.1 — the second inline error state, "invalid/unresolvable domain". */
export const INVALID_DOMAIN_MESSAGE = 'That does not look like a website address.'
