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
  // Only an update can meet this one, and it is as positive an answer as a shop
  // ever gives: the article we aimed at is not there, so nothing of ours was
  // written. Named here so a refused revision is written down as a refusal like
  // any other rather than as an ending nobody counted.
  if (shape.name === 'RemoteArticleGone') return 'refused'
  // A rate limit is a refusal by definition: the request was turned away at the
  // door and never reached the blog.
  if (shape.errorClass === 'shopify_rate_limited') return 'refused'
  // A failure the shop itself calls permanent is a request it would not accept.
  // Anything it might retry, it might also already have carried out.
  if (shape.name === 'ShopifyApiFailure' && shape.retryable === false) return 'refused'
  return 'unknown'
}

/** The four ways an attempt to post an article to a shop can end. */
export type PublishAttemptOutcome = 'succeeded' | 'refused' | 'uncertain' | 'abandoned'

/**
 * What an operator reads at three in the morning to tell one broken store from
 * a broken platform.
 *
 * The distinction the whole record exists for: many stores refused inside the
 * same hour with `shopify_rate_limited` is the platform having a bad day and is
 * what pauses publishing everywhere; one store refused with
 * `shopify_token_invalid` is that merchant's connection, which only they can
 * mend and which must never stop anybody else publishing.
 *
 * The name is taken from the failure itself rather than mapped here, so a shop
 * failure nobody has met yet arrives under its own name instead of being folded
 * into a catch-all that hides how many different things are going wrong.
 */
export function publishFailureClass(error: unknown): string {
  const shape = (error ?? {}) as ShopFailureShape
  const named = (shape as { errorClass?: unknown }).errorClass
  return typeof named === 'string' && named.length > 0 ? named : 'unclassified'
}

/**
 * How a failed send is written down: whether the shop turned it away, and what
 * went wrong.
 *
 * `uncertain` is not a synonym for failure and is deliberately not counted as
 * one. A dropped connection may have left the post on the merchant's blog; a
 * brake that read "we do not know" as "it failed" would stop publishing for
 * every store the first time a network went flaky, which is the opposite of the
 * outage it is there to catch.
 */
export function publishAttemptFailure(error: unknown): {
  readonly outcome: Extract<PublishAttemptOutcome, 'refused' | 'uncertain'>
  readonly failureClass: string
} {
  return {
    outcome: sendDisposition(error) === 'refused' ? 'refused' : 'uncertain',
    failureClass: publishFailureClass(error),
  }
}
