/**
 * What a failure at the moment of posting entitles us to assume.
 *
 * When the shop seam throws while sending an article, there are exactly two
 * situations and they need opposite responses.
 *
 * The shop **refused** — a dead token, a rate limit, a request it would not
 * accept. Nothing was written, so the claim on this publication can be given
 * back and the article tried again cleanly.
 *
 * We **do not know** — the connection broke, or the shop answered with its own
 * fault. The post may be sitting on the merchant's blog right now with nothing
 * of ours recording it. Giving the claim back here is how a merchant ends up
 * with the same article posted twice, so the claim is kept and the recovery
 * sweep settles it by asking the shop.
 *
 * Guessing the wrong way costs a duplicate post on somebody else's site, which
 * is why "we do not know" is the answer for everything not positively known to
 * have been refused.
 */

export type SendDisposition =
  /** The shop refused it. Nothing was written; the claim can be released. */
  | 'refused'
  /** It may or may not have landed. The claim stays and the sweep asks the shop. */
  | 'unknown'

interface ShopFailureShape {
  readonly name?: unknown
  readonly errorClass?: unknown
  readonly retryable?: unknown
}

/** A token the merchant has to renew, whatever threw it. */
export function isTokenRejected(error: unknown): boolean {
  return (error as ShopFailureShape | null)?.name === 'ShopifyTokenInvalid'
}

export function sendDisposition(error: unknown): SendDisposition {
  const shape = (error ?? {}) as ShopFailureShape
  if (shape.name === 'ShopifyTokenInvalid') return 'refused'
  if (shape.name === 'ShopifyNotFound') return 'refused'
  // A rate limit is a refusal by definition: the request was turned away at the
  // door and never reached the blog.
  if (shape.errorClass === 'shopify_rate_limited') return 'refused'
  // A failure the shop itself calls permanent is a request it would not accept.
  // Anything it might retry, it might also already have carried out.
  if (shape.name === 'ShopifyApiFailure' && shape.retryable === false) return 'refused'
  return 'unknown'
}
