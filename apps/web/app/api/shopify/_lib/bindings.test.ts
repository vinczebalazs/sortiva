import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MockShopifyOAuthClient, TokenCipher } from '@sortiva/providers'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { makeConnectionStore, makeDomainStore } from './bindings'

/**
 * The Shopify token, from the moment it arrives to the moment it is used again.
 *
 * What matters is that the column never holds the token: encryption happens on
 * the way in and decryption only at the point of use, so a database dump alone
 * yields nothing that can read a merchant's store.
 *
 * A token now lasts an hour and buys its own replacement, so "the point of use"
 * is a request for one rather than a read of a column — and the replacement has
 * to reach the column under the same encryption as the original.
 */

let harness: TestDb
let accountId: string
const cipher = new TokenCipher({ master: Buffer.alloc(32, 7).toString('base64') })

/** Renewing a token is the same conversation with Shopify as granting one. */
const renewer = () => new MockShopifyOAuthClient()

/** Everything but the token itself, for a grant that never needs renewing. */
const neverExpires = {
  expiresAt: null,
  refreshToken: null,
  refreshTokenExpiresAt: null,
} as const

beforeAll(async () => {
  if (!(await databaseAvailable())) {
    throw new Error('Postgres is not reachable. Run `pnpm db:up` before the test suite.')
  }
  harness = await setupTestDb('shopify_bindings')
}, 60_000)

afterAll(async () => {
  await harness?.close()
})

beforeEach(async () => {
  await truncateAll(harness.pool)
  accountId = await insertAccount(harness.pool, `bindings-${Date.now()}@example.com`)
  await harness.pool.query('INSERT INTO domains (account_id, domain_normalized) VALUES ($1,$2)', [
    accountId,
    'acme.example',
  ])
})

describe('the stored Shopify token', () => {
  it('goes in encrypted and comes back usable', async () => {
    const store = makeConnectionStore(harness.db, cipher, renewer())

    await store.save({
      accountId,
      shopHandle: 'acme',
      accessToken: 'shpat_a_real_looking_token',
      grantedScopes: ['read_products', 'read_orders', 'read_content', 'read_locales'],
      ...neverExpires,
    })

    const auth = await store.authFor(accountId)
    expect(await auth!.accessToken()).toBe('shpat_a_real_looking_token')
  })

  it('is not in the database in any readable form', async () => {
    const store = makeConnectionStore(harness.db, cipher, renewer())
    await store.save({
      accountId,
      shopHandle: 'acme',
      accessToken: 'shpat_a_real_looking_token',
      grantedScopes: ['read_products'],
      ...neverExpires,
    })

    const { rows } = await harness.pool.query<{ access_token: string }>(
      'SELECT access_token FROM shopify_conns WHERE account_id = $1',
      [accountId],
    )
    const stored = rows[0]!.access_token

    expect(stored).not.toContain('shpat_a_real_looking_token')
    expect(stored.startsWith('v1.')).toBe(true)
  })

  it('cannot be read back with a different key', async () => {
    await makeConnectionStore(harness.db, cipher, renewer()).save({
      accountId,
      shopHandle: 'acme',
      accessToken: 'shpat_a_real_looking_token',
      grantedScopes: ['read_products'],
      ...neverExpires,
    })

    const stranger = new TokenCipher({ master: Buffer.alloc(32, 9).toString('base64') })
    const auth = await makeConnectionStore(harness.db, stranger, renewer()).authFor(accountId)
    await expect(auth!.accessToken()).rejects.toThrow()
  })

  it('answers with nothing for an account that has not connected', async () => {
    expect(await makeConnectionStore(harness.db, cipher, renewer()).authFor(accountId)).toBeUndefined()
    expect(await makeConnectionStore(harness.db, cipher, renewer()).read(accountId)).toBeUndefined()
  })

  /**
   * Shopify's tokens die after an hour, and a catalogue walk can outlast one.
   * The replacement is fetched at the point of use like the original — and it
   * has to reach the column encrypted, or the hour-old connection would be the
   * one readable in a database dump.
   */
  it('replaces a token that is about to die, and stores the replacement encrypted', async () => {
    const shopify = renewer()
    const store = makeConnectionStore(harness.db, cipher, shopify)
    await store.save({
      accountId,
      shopHandle: 'acme',
      accessToken: 'shpat_nearly_dead',
      grantedScopes: ['read_products'],
      expiresAt: new Date(Date.now() - 1000),
      refreshToken: 'shprt_the_renewal_token',
      refreshTokenExpiresAt: new Date(Date.now() + 7_776_000_000),
    })

    const auth = await store.authFor(accountId)
    const token = await auth!.accessToken()

    expect(token).not.toBe('shpat_nearly_dead')
    expect(shopify.refreshes).toEqual([{ shop: 'acme', refreshToken: 'shprt_the_renewal_token' }])

    const { rows } = await harness.pool.query<{ access_token: string; refresh_token: string }>(
      'SELECT access_token, refresh_token FROM shopify_conns WHERE account_id = $1',
      [accountId],
    )
    expect(rows[0]!.access_token).not.toContain(token)
    expect(rows[0]!.access_token.startsWith('v1.')).toBe(true)
    // Shopify retires the old renewal token the first time the new one is used,
    // so the new one has to be kept — encrypted — or the next hour is the last.
    expect(rows[0]!.refresh_token).not.toContain('shprt_')
    expect(await (await store.authFor(accountId))!.accessToken()).toBe(token)
  })
})

describe('the domain a store belongs to', () => {
  it('is found by the store name a webhook names', async () => {
    await makeConnectionStore(harness.db, cipher, renewer()).save({
      accountId,
      shopHandle: 'acme',
      accessToken: 'shpat_x',
      grantedScopes: ['read_products'],
      ...neverExpires,
    })

    const domains = makeDomainStore(harness.db)
    expect(await domains.findAccountByShopHandle('acme')).toBe(accountId)
    expect(await domains.readNormalized(accountId)).toBe('acme.example')
  })

  it('moves the store only from a state that was expected', async () => {
    const domains = makeDomainStore(harness.db)

    expect(await domains.transition(accountId, ['ingesting'], 'awaiting_shopify_auth')).toBe(
      'awaiting_shopify_auth',
    )
    expect(await domains.transition(accountId, ['ingesting'], 'unsupported')).toBeUndefined()
    expect(await domains.read(accountId)).toBe('awaiting_shopify_auth')
  })
})
