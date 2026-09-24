/**
 * main Appendix A, constitution invariant 24 — canonical strings are used
 * verbatim and held by snapshot tests.
 *
 * These belong in `packages/ui/strings/*.json`, keyed by their Appendix A row
 * (constitution code-structure rules). That directory does not exist yet and
 * `packages/ui` is another lane's; T1.2 could not create it. They live here as
 * exported constants so there is exactly one copy of each string in the repo
 * and one snapshot guarding it — see DECISIONS 2026-08-31 T1.2.
 */

/**
 * Used word for word wherever what the product produces is described — the
 * landing page's pricing block today, and whatever Shopify renders when billing
 * moves there. It states a ceiling, never a denominator or a target, so nothing
 * renders it as "x of y": the cap is what we will not exceed, not what we
 * promise to hit.
 */
export const PLAN_CAP_LINE = 'Up to 1 article per day, quality permitting' as const

/**
 * Stated wherever cancellation is offered. With the purchase layer gone that is
 * the delete-account confirmation; it returns to a billing screen when Shopify
 * renders one.
 */
export const CANCELLATION_FACTS = [
  'Your published articles stay on your store.',
  'Generation stops at the end of your billing period.',
  'You keep read access to everything.',
] as const

/** The reassurance line under the pricing block. */
export const PLAN_CANCEL_ANYTIME = 'Cancel anytime.' as const

/**
 * The non-dismissible banner while the subscription is `past_due`.
 *
 * Nothing can reach that status while there is no purchase layer — only a
 * payment processor's webhook ever wrote it. The status, the banner and the
 * gate behaviour are kept because dunning is a real product concept that
 * returns with Shopify billing, and because a status the database can still
 * hold must still render as something.
 */
export const PAYMENT_FAILED_BANNER = 'Payment failed — update your card' as const
