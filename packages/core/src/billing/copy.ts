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
 * main §4.2 — "The cap wording appears verbatim on the plan screen and in the
 * Stripe product description". Invariant 23: a ceiling, never a denominator or
 * a target, so nothing here renders "x of y".
 */
export const PLAN_CAP_LINE = 'Up to 1 article per day, quality permitting' as const

/**
 * main §14.6, ui §9.4 — "stated wherever cancellation is offered": on the
 * Customer Portal return screen, on the Settings billing card, and on the
 * delete-account confirmation.
 */
export const CANCELLATION_FACTS = [
  'Your published articles stay on your store.',
  'Generation stops at the end of your billing period.',
  'You keep read access to everything.',
] as const

/** ui §2.3 — the plan card's own reassurance line, above the single button. */
export const PLAN_CANCEL_ANYTIME = 'Cancel anytime.' as const

/** ui §2.3 — the neutral note when the merchant backs out of Stripe Checkout. */
export const CHECKOUT_CANCELED_NOTE = 'No charge was made.' as const

/**
 * main §4.2, ui §10 — the non-dismissible banner while the subscription is
 * `past_due`. Stripe Smart Retries is still working the card in the background;
 * the merchant's only action is the Customer Portal.
 */
export const PAYMENT_FAILED_BANNER = 'Payment failed — update your card' as const
