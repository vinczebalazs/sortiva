/**
 * The user-facing strings for connecting a store, in one module with a snapshot
 * test on them — the same treatment T1.2 gave the billing copy and T1.4 the
 * domain-claim copy, and for the same reason: `packages/ui/strings/*.json` does
 * not exist yet and belongs to another lane. See DECISIONS 2026-08-31 T1.2.
 *
 * The first two are fixed copy, used word for word.
 */

/**
 * Shown when the claimed site is not a Shopify store. The domain stays claimed
 * and the account is parked here: there is no self-serve way out in V1, which
 * is why the sentence has to offer a person to talk to.
 */
export const NOT_SHOPIFY_PARKED_MESSAGE =
  "This doesn't look like a Shopify store. We currently support Shopify only — contact us for a custom solution or join the waitlist."

/**
 * Shown on the connect screen, next to the button that starts the handshake.
 * The single most important sentence on that screen: fear of waking up to posts
 * they did not approve is the main reason a merchant stops here.
 */
export const SHOPIFY_READ_ONLY_TRUST_MESSAGE =
  "Read-only — we can't change anything in your store with this permission. Auto-publishing is a separate optional setting you control later."

/** The headline above it. */
export const SHOPIFY_CONNECT_HEADLINE = 'Connect your Shopify store to continue.'

/**
 * Shown once a token we held stops working — the merchant uninstalled the app,
 * or Shopify revoked it. Their existing articles, opportunities and history stay
 * readable; only new work stops, which is what this sentence has to convey
 * without alarming them.
 */
export const SHOPIFY_DISCONNECTED_MESSAGE =
  'Your Shopify connection was lost — reconnect to resume.'
