/**
 * The user-facing strings of the domain claim, in one module with a snapshot
 * test on them — the same treatment T1.2 gave the billing copy, and for the
 * same reason: `packages/ui/strings/*.json` does not exist yet and belongs to
 * another lane. See DECISIONS 2026-08-31 T1.2.
 */

/**
 * Fixed copy, used word for word. Rendered inline under the URL input with a
 * support link: transfers are support-mediated, so there is no self-serve way to
 * take a domain off another account.
 */
export const DOMAIN_ALREADY_CLAIMED_MESSAGE =
  'This domain is already connected to another account. If you believe this is a mistake, contact support.'

/**
 * The other half of one-domain-per-account. The UI only ever shows the connect
 * box to an account with no domain, so this exists for the paths that reach the
 * route anyway: a stale tab, a second browser, a direct API call. Copy invented
 * by T1.4 and awaiting founder sign-off; the transfer posture is the same
 * support-mediated one as above.
 */
export function accountHasOtherDomainMessage(current: string): string {
  return `This account is already connected to ${current}. An account connects one domain — contact support if you need to change it.`
}

/** The other inline error under the URL input: what they typed is not a domain. */
export const INVALID_DOMAIN_MESSAGE = 'That does not look like a website address.'
