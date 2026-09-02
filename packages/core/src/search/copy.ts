/**
 * The user-facing strings of the Search Console connection, in one module with a
 * snapshot test on them — the same treatment the domain claim and the billing
 * copy got, and for the same reason: `packages/ui/strings` belongs to another
 * lane and did not exist when this was written. See DECISIONS 2026-08-31 T1.2.
 *
 * None of these is a canonical string from the copy appendix; the two that are —
 * the connect prompt and the badge — are rendered by the screens, not by this
 * API, so they are not restated here where they could drift from the originals.
 */

/**
 * Shown when the merchant chooses a property for a different website. Naming the
 * store is the whole point: an agency merchant sees several properties and needs
 * to know which one we mean, not merely that theirs was refused.
 */
export function gscPropertyMismatchMessage(claimedDomain: string): string {
  return `That Search Console property is not for ${claimedDomain}.`
}

/** The same refusal, said as an instruction against the field itself. */
export function gscPropertyMismatchHint(claimedDomain: string): string {
  return `Choose a property for ${claimedDomain}.`
}

/**
 * Reached only by a stale tab or a direct call — the picker is not shown before
 * Google has granted access.
 */
export const GSC_NOT_GRANTED_MESSAGE = 'Connect Search Console before choosing a property.'

/** Likewise: no screen offers this before a store is connected. */
export const GSC_NO_DOMAIN_MESSAGE = 'Connect your store before choosing a property.'

/** The 422 when the request body carries no property at all. */
export const GSC_PROPERTY_REQUIRED_MESSAGE = 'Choose a Search Console property.'
