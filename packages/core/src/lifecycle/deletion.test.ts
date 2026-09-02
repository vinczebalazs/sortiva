import { describe, expect, it } from 'vitest'
import { deleteAccount } from './deletion'
import type { AccessRevoker, AccountLifecycleRecord, AccountLifecycleStore } from './ports'

const AT = new Date('2026-09-02T12:00:00.000Z')

function record(overrides: Partial<AccountLifecycleRecord> = {}): AccountLifecycleRecord {
  return {
    accountId: 'acc-1',
    email: 'merchant@example.com',
    domainNormalized: 'example.com',
    stripeSubscriptionId: 'sub_123',
    shopifyToken: { shopHandle: 'example-store', accessToken: 'shpat_live' },
    googleRefreshToken: 'google-refresh',
    deletedAt: null,
    ...overrides,
  }
}

interface World {
  store: AccountLifecycleStore
  billing: { cancelNow: (id: string) => Promise<void> }
  revoker: AccessRevoker
  calls: string[]
  marked: { accountId: string; at: Date; domainReleaseAt: Date }[]
  previewPurged: string[]
}

function world(
  row: AccountLifecycleRecord | undefined,
  faults: { stripe?: Error; shopify?: Error; google?: Error; markReturns?: boolean } = {},
): World {
  const calls: string[] = []
  const marked: World['marked'] = []
  const previewPurged: string[] = []
  return {
    calls,
    marked,
    previewPurged,
    store: {
      async load() {
        return row
      },
      async markDeleted(input) {
        calls.push('mark')
        marked.push(input)
        return faults.markReturns ?? true
      },
      async purgePreviewCache(domain) {
        calls.push('preview')
        previewPurged.push(domain)
      },
    },
    billing: {
      async cancelNow(id) {
        calls.push(`cancel:${id}`)
        if (faults.stripe) throw faults.stripe
      },
    },
    revoker: {
      async revokeShopify() {
        calls.push('revoke:shopify')
        if (faults.shopify) throw faults.shopify
      },
      async revokeGoogle() {
        calls.push('revoke:google')
        if (faults.google) throw faults.google
      },
    },
  }
}

describe('deleting an account', () => {
  it('cancels the subscription once, revokes both grants, then writes the deletion', async () => {
    const w = world(record())
    const result = await deleteAccount(
      { store: w.store, billing: w.billing, revoker: w.revoker, now: () => AT },
      { accountId: 'acc-1' },
    )

    expect(w.calls).toEqual(['cancel:sub_123', 'revoke:shopify', 'revoke:google', 'mark', 'preview'])
    expect(result).toEqual({
      kind: 'deleted',
      deletedAt: AT,
      domainFreeAt: new Date('2026-09-09T12:00:00.000Z'),
      subscriptionCancelled: true,
      revoked: { shopify: true, google: true },
    })
    expect(w.previewPurged).toEqual(['example.com'])
  })

  it('holds the domain for seven days rather than releasing it now', async () => {
    const w = world(record())
    await deleteAccount(
      { store: w.store, billing: w.billing, revoker: w.revoker, now: () => AT },
      { accountId: 'acc-1' },
    )
    expect(w.marked[0]!.domainReleaseAt).toEqual(new Date('2026-09-09T12:00:00.000Z'))
  })

  it('refuses to delete anything when the subscription will not cancel', async () => {
    // A deleted account whose card is still being charged is the worst outcome
    // available here, so the whole request fails and nothing else has run.
    const w = world(record(), { stripe: new Error('stripe is down') })
    await expect(
      deleteAccount(
        { store: w.store, billing: w.billing, revoker: w.revoker, now: () => AT },
        { accountId: 'acc-1' },
      ),
    ).rejects.toThrow('stripe is down')
    expect(w.calls).toEqual(['cancel:sub_123'])
    expect(w.marked).toEqual([])
  })

  it('still deletes when a vendor refuses to take its grant back, and says which', async () => {
    const w = world(record(), { google: new Error('invalid_grant') })
    const warnings: string[] = []
    const result = await deleteAccount(
      {
        store: w.store,
        billing: w.billing,
        revoker: w.revoker,
        now: () => AT,
        log: {
          debug() {},
          info() {},
          warn: (msg) => warnings.push(msg),
          error() {},
          child() {
            return this as never
          },
        },
      },
      { accountId: 'acc-1' },
    )
    expect(result).toMatchObject({ kind: 'deleted', revoked: { shopify: true, google: false } })
    expect(warnings).toEqual(['token_revocation_failed'])
    // The token is destroyed locally regardless; a vendor being down is not a
    // reason to refuse somebody's deletion.
    expect(w.calls).toContain('mark')
  })

  it('calls no vendor for an account that never connected anything', async () => {
    const w = world(
      record({ stripeSubscriptionId: null, shopifyToken: null, googleRefreshToken: null }),
    )
    const result = await deleteAccount(
      { store: w.store, billing: w.billing, revoker: w.revoker, now: () => AT },
      { accountId: 'acc-1' },
    )
    expect(w.calls).toEqual(['mark', 'preview'])
    expect(result).toMatchObject({
      subscriptionCancelled: false,
      revoked: { shopify: null, google: null },
    })
  })

  it('leaves no preview row behind for an account with no domain', async () => {
    const w = world(record({ domainNormalized: null }))
    const result = await deleteAccount(
      { store: w.store, billing: w.billing, revoker: w.revoker, now: () => AT },
      { accountId: 'acc-1' },
    )
    expect(w.previewPurged).toEqual([])
    expect(result).toMatchObject({ domainFreeAt: null })
  })

  it('is a no-op the second time, rather than cancelling a cancelled subscription', async () => {
    const w = world(record({ deletedAt: new Date('2026-09-01T00:00:00Z') }))
    const result = await deleteAccount(
      { store: w.store, billing: w.billing, revoker: w.revoker, now: () => AT },
      { accountId: 'acc-1' },
    )
    expect(result).toEqual({ kind: 'already_deleted' })
    expect(w.calls).toEqual([])
  })

  it('stands down when another request won the guarded write', async () => {
    const w = world(record(), { markReturns: false })
    const result = await deleteAccount(
      { store: w.store, billing: w.billing, revoker: w.revoker, now: () => AT },
      { accountId: 'acc-1' },
    )
    expect(result).toEqual({ kind: 'already_deleted' })
    expect(w.previewPurged).toEqual([])
  })

  it('answers not_found rather than throwing for an account that is gone', async () => {
    const w = world(undefined)
    const result = await deleteAccount(
      { store: w.store, billing: w.billing, revoker: w.revoker, now: () => AT },
      { accountId: 'missing' },
    )
    expect(result).toEqual({ kind: 'not_found' })
  })

  it('reports the deletion with identifiers and outcomes, never an address', async () => {
    const w = world(record())
    const events: unknown[] = []
    await deleteAccount(
      {
        store: w.store,
        billing: w.billing,
        revoker: w.revoker,
        now: () => AT,
        capture: { capture: (e) => events.push(e) },
      },
      { accountId: 'acc-1' },
    )
    expect(events).toEqual([
      {
        event: 'account_deleted',
        attribution: { kind: 'account', accountId: 'acc-1', domain: 'example.com' },
        properties: {
          subscription_cancelled: true,
          shopify_grant: 'revoked',
          google_grant: 'revoked',
        },
      },
    ])
    expect(JSON.stringify(events)).not.toContain('merchant@example.com')
  })
})
