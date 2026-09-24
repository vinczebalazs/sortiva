import { describe, expect, it } from 'vitest'
import {
  assertReadOnlyGrant,
  canPublish,
  SHOPIFY_PUBLISH_SCOPE,
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
  it('asks for exactly the three read scopes', () => {
    // Nothing asks for the store's languages any more: the only thing we ever
    // wanted from them was which language the shop writes in, and the store's
    // primary domain states that without a permission of its own. Every
    // permission we ask for is one a merchant has to read and agree to, so one
    // that buys nothing is one worth not asking for.
    expect([...SHOPIFY_READ_SCOPES]).toEqual(['read_products', 'read_orders', 'read_content'])
    expect([...SHOPIFY_READ_SCOPES]).not.toContain('read_locales')
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

/**
 * The one exception, and it is the merchant's own doing.
 *
 * A store that went through the publishing screen and said yes is handed
 * publishing back by Shopify every time it reconnects, whether we ask for it or
 * not. Refusing that token would lock out precisely the merchants who trusted us
 * most: they could never reconnect at all, and no amount of clicking would help
 * because we are not the ones adding the permission.
 */
describe('a store that already allowed publishing, reconnecting', () => {
  it('accepts publishing handed back to a store that granted it before', () => {
    expect(() =>
      assertReadOnlyGrant(['read_products', 'read_orders', SHOPIFY_PUBLISH_SCOPE], {
        publishGrantedBefore: true,
      }),
    ).not.toThrow()
  })

  it('still refuses publishing for a store that never granted it', () => {
    // The default, and the install path: nobody has agreed to anything, so a
    // write permission arriving is Shopify's dashboard talking, not the merchant.
    expect(() => assertReadOnlyGrant(['read_products', SHOPIFY_PUBLISH_SCOPE])).toThrow(
      WriteScopeGranted,
    )
    expect(() =>
      assertReadOnlyGrant(['read_products', SHOPIFY_PUBLISH_SCOPE], { publishGrantedBefore: false }),
    ).toThrow(WriteScopeGranted)
  })

  it('refuses any other write permission however the store got here', () => {
    // Permission to post articles is the only thing that may come back this way.
    // Anything else — the catalogue, orders, the storefront itself — is refused
    // for every store, and refused even when it arrives alongside the one
    // permission we allow.
    expect(() =>
      assertReadOnlyGrant(['read_products', 'write_products'], { publishGrantedBefore: true }),
    ).toThrow(WriteScopeGranted)
    expect(() =>
      assertReadOnlyGrant(['read_products', SHOPIFY_PUBLISH_SCOPE, 'write_products'], {
        publishGrantedBefore: true,
      }),
    ).toThrow(WriteScopeGranted)
  })

  it('names every write permission it refused, so the log says what happened', () => {
    try {
      assertReadOnlyGrant(['write_orders', 'write_products'], { publishGrantedBefore: true })
      expect.unreachable('the grant should have been refused')
    } catch (error) {
      expect((error as WriteScopeGranted).scopes).toEqual(['write_orders', 'write_products'])
    }
  })
})
