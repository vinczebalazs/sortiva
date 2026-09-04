import { describe, expect, it } from 'vitest'
import { isTokenRejected, sendDisposition } from './failure'

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
