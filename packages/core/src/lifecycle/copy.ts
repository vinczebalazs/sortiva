/**
 * What the delete-account screen must say before a merchant confirms.
 *
 * Four of these are promises the code then has to keep, which is why they are
 * here beside the code that keeps them rather than only in the interface: the
 * subscription really is cancelled in the same request, the tokens really are
 * handed back, the domain really does stay blocked for a week, and the rows
 * really are erased. The fifth exists because it is the fear people actually
 * have — that deleting the account unpublishes their articles — and the answer
 * is no, they are on the merchant's own store and we never touch them.
 *
 * These live as constants for the same reason the billing lines do: one copy of
 * each sentence in the repository, held by a snapshot, mirrored into the string
 * catalogue the interface reads.
 */
export const ACCOUNT_DELETION_FACTS = [
  'Your subscription is cancelled immediately — there will be no further charges.',
  'Your published articles stay on your store. We never touch them.',
  'We hand back access to your Shopify store and your Search Console.',
  'Your domain stays reserved for 7 days, in case this was a mistake.',
  'Everything we hold about your store is erased within 30 days.',
] as const

/** Typed back into the confirmation field; the action cannot be undone. */
export const ACCOUNT_DELETION_CONFIRM_WORD = 'DELETE' as const
