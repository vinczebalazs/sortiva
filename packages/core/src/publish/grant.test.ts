import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { SHOPIFY_READ_SCOPES, SHOPIFY_READ_SCOPE_PARAM } from '../catalog/scopes'
import {
  assertPublishGrant,
  autoPublishReadiness,
  PublishScopeMissing,
  PUBLISH_GRANT_STATE_TTL_MS,
  SHOPIFY_PUBLISH_SCOPE,
  SHOPIFY_PUBLISH_SCOPES,
  SHOPIFY_PUBLISH_SCOPE_PARAM,
  signPublishGrantState,
  verifyPublishGrantState,
} from './grant'

const SECRET = 'a-test-app-secret'

describe('the two Shopify consents are separate (invariant 21)', () => {
  it('asks for no write permission at install', () => {
    // Re-asserted here as well as in the catalogue's own test: this file adds
    // the write grant, and the promise on the connect screen is only true so
    // long as adding it did not widen the first one.
    expect(SHOPIFY_READ_SCOPE_PARAM).not.toContain('write_')
    for (const scope of SHOPIFY_READ_SCOPES) expect(scope.startsWith('read_')).toBe(true)
  })

  it('asks for exactly one write permission at the second grant, and keeps the read ones', () => {
    expect(SHOPIFY_PUBLISH_SCOPE).toBe('write_content')
    expect(SHOPIFY_PUBLISH_SCOPES.filter((s) => s.startsWith('write_'))).toEqual(['write_content'])
    // Shopify replaces a token's whole scope set per grant; dropping the read
    // scopes here would trade the catalogue sync for the ability to publish.
    for (const scope of SHOPIFY_READ_SCOPES) expect(SHOPIFY_PUBLISH_SCOPES).toContain(scope)
    expect(SHOPIFY_PUBLISH_SCOPE_PARAM).toContain('write_content')
  })

  it('refuses a second grant that came back without posting permission', () => {
    expect(() => assertPublishGrant([...SHOPIFY_READ_SCOPES])).toThrow(PublishScopeMissing)
    expect(() => assertPublishGrant([...SHOPIFY_PUBLISH_SCOPES])).not.toThrow()
  })
})

describe('whether auto-publish may be switched on', () => {
  it('needs posting permission first', () => {
    expect(autoPublishReadiness({ grantedScopes: ['read_products'], targetBlogId: 'b1' })).toEqual({
      ok: false,
      code: 'write_scope_required',
    })
  })

  it('refuses a store with permission but no chosen blog', () => {
    expect(
      autoPublishReadiness({ grantedScopes: [...SHOPIFY_PUBLISH_SCOPES], targetBlogId: null }),
    ).toEqual({ ok: false, code: 'target_blog_unresolved' })
  })

  it('allows a store with both', () => {
    expect(
      autoPublishReadiness({ grantedScopes: [...SHOPIFY_PUBLISH_SCOPES], targetBlogId: 'b1' }),
    ).toEqual({ ok: true })
  })
})

describe('the value carried through the consent screen and back', () => {
  const state = { accountId: 'acc-1', shop: 'acme', issuedAt: Date.parse('2026-09-04T09:00:00Z') }
  const now = new Date('2026-09-04T09:01:00Z')

  it('round-trips when the signature holds', () => {
    expect(verifyPublishGrantState(signPublishGrantState(state, SECRET), SECRET, now)).toEqual(state)
  })

  it('refuses one signed with another secret', () => {
    expect(verifyPublishGrantState(signPublishGrantState(state, 'other'), SECRET, now)).toBeUndefined()
  })

  it('refuses a tampered payload', () => {
    const signed = signPublishGrantState(state, SECRET)
    const forged = `${Buffer.from(JSON.stringify({ ...state, accountId: 'acc-2', purpose: 'shopify_publish_grant' })).toString('base64url')}.${signed.slice(signed.lastIndexOf('.') + 1)}`
    expect(verifyPublishGrantState(forged, SECRET, now)).toBeUndefined()
  })

  it('refuses an install redirect replayed at the publishing callback', () => {
    // No `purpose`, which is what an install-flow state looks like. Without
    // this check a read-only grant could be recorded as a publishing one.
    const payload = Buffer.from(JSON.stringify(state), 'utf8').toString('base64url')
    const signature = createHmac('sha256', SECRET).update(payload).digest('base64url')
    expect(verifyPublishGrantState(`${payload}.${signature}`, SECRET, now)).toBeUndefined()
  })

  it('refuses one that has gone stale', () => {
    const late = new Date(state.issuedAt + PUBLISH_GRANT_STATE_TTL_MS + 1000)
    expect(verifyPublishGrantState(signPublishGrantState(state, SECRET), SECRET, late)).toBeUndefined()
  })

  it('refuses rubbish without throwing', () => {
    expect(verifyPublishGrantState('', SECRET, now)).toBeUndefined()
    expect(verifyPublishGrantState('no-dot', SECRET, now)).toBeUndefined()
    expect(verifyPublishGrantState('!!!.???', SECRET, now)).toBeUndefined()
  })
})
