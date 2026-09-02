import { describe, expect, it } from 'vitest'
import {
  NOT_SHOPIFY_PARKED_MESSAGE,
  SHOPIFY_CONNECT_HEADLINE,
  SHOPIFY_DISCONNECTED_MESSAGE,
  SHOPIFY_READ_ONLY_TRUST_MESSAGE,
} from './copy'

/**
 * Two of these are canonical strings — agreed wording, used word for word
 * wherever they appear. A paraphrase is a regression, so they are pinned here.
 */

describe('store connection copy', () => {
  it('parks a non-Shopify store in the agreed words', () => {
    expect(NOT_SHOPIFY_PARKED_MESSAGE).toBe(
      "This doesn't look like a Shopify store. We currently support Shopify only — contact us for a custom solution or join the waitlist.",
    )
  })

  it('states the read-only promise in the agreed words', () => {
    expect(SHOPIFY_READ_ONLY_TRUST_MESSAGE).toBe(
      "Read-only — we can't change anything in your store with this permission. Auto-publishing is a separate optional setting you control later.",
    )
  })

  it('promises no write access and names the separate later consent', () => {
    expect(SHOPIFY_READ_ONLY_TRUST_MESSAGE).toContain('Read-only')
    expect(SHOPIFY_READ_ONLY_TRUST_MESSAGE).toContain('separate optional setting')
  })

  it('has no denominators or counts anywhere', () => {
    for (const copy of [
      NOT_SHOPIFY_PARKED_MESSAGE,
      SHOPIFY_CONNECT_HEADLINE,
      SHOPIFY_DISCONNECTED_MESSAGE,
      SHOPIFY_READ_ONLY_TRUST_MESSAGE,
    ]) {
      expect(copy).not.toMatch(/\b\d+\s*(of|\/)\s*\d+\b/)
    }
  })
})
