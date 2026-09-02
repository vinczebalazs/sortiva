import { describe, expect, it } from 'vitest'
import { closeAccount, requestAccountDeletion } from './deletion'
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
      async queueClosure() {
        calls.push('queue-closure')
      },
      async clearGrants() {
        calls.push('clear-grants')
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

describe('the half a merchant waits for', () => {
  it('writes the deletion and drops the preview row, touching no vendor', async () => {
    const w = world(record())
    const result = await requestAccountDeletion({ store: w.store, now: () => AT }, {
      accountId: 'acc-1',
    })

    expect(w.calls).toEqual(['mark', 'preview', 'queue-closure'])
    expect(result).toEqual({
      kind: 'deleted',
      deletedAt: AT,
      domainFreeAt: new Date('2026-09-09T12:00:00.000Z'),
    })
    expect(w.previewPurged).toEqual(['example.com'])
  })

  it('holds the domain for seven days rather than releasing it now', async () => {
    const w = world(record())
    await requestAccountDeletion({ store: w.store, now: () => AT }, { accountId: 'acc-1' })
    expect(w.marked[0]!.domainReleaseAt).toEqual(new Date('2026-09-09T12:00:00.000Z'))
  })

  it('leaves no preview row behind for an account with no domain', async () => {
    const w = world(record({ domainNormalized: null }))
    const result = await requestAccountDeletion({ store: w.store, now: () => AT }, {
      accountId: 'acc-1',
    })
    expect(w.previewPurged).toEqual([])
    expect(w.calls).toEqual(['mark', 'queue-closure'])
    expect(result).toMatchObject({ domainFreeAt: null })
  })

  it('is a no-op the second time', async () => {
    const w = world(record({ deletedAt: new Date('2026-09-01T00:00:00Z') }))
    const result = await requestAccountDeletion({ store: w.store, now: () => AT }, {
      accountId: 'acc-1',
    })
    expect(result).toEqual({ kind: 'already_deleted' })
    expect(w.calls).toEqual([])
  })

  it('stands down when another request won the guarded write', async () => {
    const w = world(record(), { markReturns: false })
    const result = await requestAccountDeletion({ store: w.store, now: () => AT }, {
      accountId: 'acc-1',
    })
    expect(result).toEqual({ kind: 'already_deleted' })
    expect(w.previewPurged).toEqual([])
  })

  it('answers not_found rather than throwing for an account that is gone', async () => {
    const w = world(undefined)
    expect(
      await requestAccountDeletion({ store: w.store, now: () => AT }, { accountId: 'missing' }),
    ).toEqual({ kind: 'not_found' })
  })

  it('reports the deletion with identifiers only, never an address', async () => {
    const w = world(record())
    const events: unknown[] = []
    await requestAccountDeletion(
      { store: w.store, now: () => AT, capture: { capture: (e) => events.push(e) } },
      { accountId: 'acc-1' },
    )
    expect(events).toEqual([
      {
        event: 'account_deleted',
        attribution: { kind: 'account', accountId: 'acc-1', domain: 'example.com' },
        properties: { had_subscription: true },
      },
    ])
    expect(JSON.stringify(events)).not.toContain('merchant@example.com')
  })
})

const deleted = { deletedAt: new Date('2026-09-02T12:00:00.000Z') }

describe('the half that talks to vendors', () => {
  it('cancels the subscription once, hands both grants back, then destroys the tokens', async () => {
    const w = world(record(deleted))
    const result = await closeAccount(
      { store: w.store, billing: w.billing, revoker: w.revoker },
      { accountId: 'acc-1' },
    )
    expect(w.calls).toEqual([
      'cancel:sub_123',
      'revoke:shopify',
      'revoke:google',
      'clear-grants',
    ])
    expect(result).toEqual({
      kind: 'closed',
      subscriptionCancelled: true,
      revoked: { shopify: true, google: true },
    })
  })

  it('fails the job rather than proceeding when the subscription will not cancel', async () => {
    // Retried, and dead-lettered if it keeps failing. A deleted account whose
    // card is still being charged has to be somebody's alert, not a silent log
    // line.
    const w = world(record(deleted), { stripe: new Error('stripe is down') })
    await expect(
      closeAccount({ store: w.store, billing: w.billing, revoker: w.revoker }, { accountId: 'acc-1' }),
    ).rejects.toThrow('stripe is down')
    expect(w.calls).toEqual(['cancel:sub_123'])
  })

  it('finishes when a vendor refuses to take its grant back, and says which', async () => {
    const w = world(record(deleted), { google: new Error('invalid_grant') })
    const warnings: string[] = []
    const result = await closeAccount(
      {
        store: w.store,
        billing: w.billing,
        revoker: w.revoker,
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
    expect(result).toMatchObject({ revoked: { shopify: true, google: false } })
    expect(warnings).toEqual(['token_revocation_failed'])
    // The token is destroyed regardless; a vendor being down is not a reason to
    // leave a deleted merchant's credential in our database.
    expect(w.calls).toContain('clear-grants')
  })

  it('calls no vendor for an account that never connected anything', async () => {
    const w = world(
      record({ ...deleted, stripeSubscriptionId: null, shopifyToken: null, googleRefreshToken: null }),
    )
    const result = await closeAccount(
      { store: w.store, billing: w.billing, revoker: w.revoker },
      { accountId: 'acc-1' },
    )
    expect(w.calls).toEqual(['clear-grants'])
    expect(result).toMatchObject({
      subscriptionCancelled: false,
      revoked: { shopify: null, google: null },
    })
  })

  it('refuses to touch the grants of an account whose deletion was never requested', async () => {
    const w = world(record())
    expect(
      await closeAccount(
        { store: w.store, billing: w.billing, revoker: w.revoker },
        { accountId: 'acc-1' },
      ),
    ).toEqual({ kind: 'skipped', why: 'not_deleted' })
    expect(w.calls).toEqual([])
  })

  it('does nothing for an account already erased by the sweep', async () => {
    const w = world(undefined)
    expect(
      await closeAccount(
        { store: w.store, billing: w.billing, revoker: w.revoker },
        { accountId: 'gone' },
      ),
    ).toEqual({ kind: 'skipped', why: 'not_found' })
  })
})
