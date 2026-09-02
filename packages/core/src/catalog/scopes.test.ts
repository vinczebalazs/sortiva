import { describe, expect, it } from 'vitest'
import {
  assertReadOnlyGrant,
  canPublish,
  SHOPIFY_READ_SCOPES,
  SHOPIFY_READ_SCOPE_PARAM,
  WriteScopeGranted,
} from './scopes'

/**
 * The promise on the connect screen is that installing Sortiva cannot change
 * anything in the merchant's store. These are the tests that make that true
 * rather than merely intended.
 */

describe('shopify install scopes', () => {
  it('asks for exactly the four read scopes', () => {
    expect([...SHOPIFY_READ_SCOPES]).toEqual([
      'read_products',
      'read_orders',
      'read_content',
      'read_locales',
    ])
  })

  it('asks for no write permission of any kind', () => {
    for (const scope of SHOPIFY_READ_SCOPES) {
      expect(scope.startsWith('write_')).toBe(false)
    }
    expect(SHOPIFY_READ_SCOPE_PARAM).not.toContain('write_')
  })

  it('refuses a grant that came back with a write scope', () => {
    expect(() => assertReadOnlyGrant(['read_products', 'write_content'])).toThrow(WriteScopeGranted)
  })

  it('accepts a grant that is read-only, even when it is narrower than we asked', () => {
    expect(() => assertReadOnlyGrant(['read_products'])).not.toThrow()
  })

  it('does not consider an install connection able to publish', () => {
    expect(canPublish([...SHOPIFY_READ_SCOPES])).toBe(false)
    expect(canPublish(['read_products', 'write_content'])).toBe(true)
  })
})
