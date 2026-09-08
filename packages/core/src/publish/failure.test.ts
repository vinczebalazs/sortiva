import { describe, expect, it } from 'vitest'
import { isTokenRejected, publishAttemptFailure, sendDisposition } from './failure'

/**
 * The one question that decides whether a failed post may be tried again from
 * scratch. Getting it wrong in one direction strands an article for ever;
 * getting it wrong in the other puts the same article on a merchant's blog
 * twice, so everything not positively known to have been refused is treated as
 * "we do not know".
 */

const tokenInvalid = { name: 'ShopifyTokenInvalid', retryable: false, errorClass: 'shopify_token_invalid' }
const rateLimited = { name: 'ShopifyApiFailure', retryable: true, errorClass: 'shopify_rate_limited' }
const badRequest = { name: 'ShopifyApiFailure', retryable: false, errorClass: 'shopify_api_error' }
const serverFault = { name: 'ShopifyApiFailure', retryable: true, errorClass: 'shopify_api_error' }
const blogGone = { name: 'ShopifyNotFound', retryable: false, errorClass: 'shopify_not_found' }
const postDeleted = { name: 'RemoteArticleGone', retryable: false, errorClass: 'remote_article_gone' }

describe('whether a post that failed could still have landed', () => {
  it('treats a rejected token as never having reached the blog', () => {
    expect(sendDisposition(tokenInvalid)).toBe('refused')
  })

  it('treats a rate limit as a refusal at the door', () => {
    expect(sendDisposition(rateLimited)).toBe('refused')
  })

  it('treats a request Shopify would not accept as a refusal', () => {
    expect(sendDisposition(badRequest)).toBe('refused')
    expect(sendDisposition(blogGone)).toBe('refused')
  })

  it('refuses to assume anything about a fault of Shopify`s own', () => {
    expect(sendDisposition(serverFault)).toBe('unknown')
  })

  it('refuses to assume anything about a failure it does not recognise', () => {
    expect(sendDisposition(new Error('the connection went away'))).toBe('unknown')
    expect(sendDisposition(undefined)).toBe('unknown')
    expect(sendDisposition('a string somebody threw')).toBe('unknown')
  })
})

describe('which failures are the merchant`s to fix', () => {
  it('recognises a token only the merchant can renew', () => {
    expect(isTokenRejected(tokenInvalid)).toBe(true)
  })

  it('does not mistake anything else for one', () => {
    expect(isTokenRejected(rateLimited)).toBe(false)
    expect(isTokenRejected(new Error('boom'))).toBe(false)
    expect(isTokenRejected(null)).toBe(false)
  })
})

describe('what an operator can tell apart in an incident', () => {
  /**
   * The distinction the whole record exists for. Both of these are refusals and
   * both stop an article going out, and confusing them is the difference
   * between paging somebody about the platform and emailing one merchant.
   */
  it('separates a shop asking us to slow down from one merchant`s dead token', () => {
    expect(publishAttemptFailure(rateLimited)).toEqual({
      outcome: 'refused',
      failureClass: 'shopify_rate_limited',
    })
    expect(publishAttemptFailure(tokenInvalid)).toEqual({
      outcome: 'refused',
      failureClass: 'shopify_token_invalid',
    })
  })

  it('writes a post the merchant deleted down as a refusal, not as a failure nobody counted', () => {
    // An update to an article that is gone is as definite an answer as a shop
    // gives: nothing of ours was written. Left as "we do not know" it would
    // vanish from the count entirely.
    expect(publishAttemptFailure(postDeleted)).toEqual({
      outcome: 'refused',
      failureClass: 'remote_article_gone',
    })
  })

  it('does not let a shop`s own fault be counted as a failure', () => {
    // The post may be on the merchant's blog. Counted as a failure, a flaky
    // network would raise the same switch a real outage does.
    expect(publishAttemptFailure(serverFault)).toEqual({
      outcome: 'uncertain',
      failureClass: 'shopify_api_error',
    })
    expect(publishAttemptFailure(blogGone)).toEqual({
      outcome: 'refused',
      failureClass: 'shopify_not_found',
    })
  })

  it('says plainly that it could not name a failure rather than inventing one', () => {
    expect(publishAttemptFailure(new Error('the connection went away'))).toEqual({
      outcome: 'uncertain',
      failureClass: 'unclassified',
    })
    expect(publishAttemptFailure(undefined).failureClass).toBe('unclassified')
  })
})
