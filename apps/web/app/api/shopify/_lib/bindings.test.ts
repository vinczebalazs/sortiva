import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { TokenCipher } from '@sortiva/providers'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { makeConnectionStore, makeDomainStore } from './bindings'

/**
 * The Shopify token, from the moment it arrives to the moment it is used again.
 *
 * What matters is that the column never holds the token: encryption happens on
 * the way in and decryption only at the point of use, so a database dump alone
 * yields nothing that can read a merchant's store.
 */

let harness: TestDb
let accountId: string
const cipher = new TokenCipher({ master: Buffer.alloc(32, 7).toString('base64') })

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
    const store = makeConnectionStore(harness.db, cipher)

    await store.save({
      accountId,
      shopHandle: 'acme',
      accessToken: 'shpat_a_real_looking_token',
      grantedScopes: ['read_products', 'read_orders', 'read_content', 'read_locales'],
    })

    expect(await store.readToken(accountId)).toBe('shpat_a_real_looking_token')
  })

  it('is not in the database in any readable form', async () => {
    const store = makeConnectionStore(harness.db, cipher)
    await store.save({
      accountId,
      shopHandle: 'acme',
      accessToken: 'shpat_a_real_looking_token',
      grantedScopes: ['read_products'],
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
    await makeConnectionStore(harness.db, cipher).save({
      accountId,
      shopHandle: 'acme',
      accessToken: 'shpat_a_real_looking_token',
      grantedScopes: ['read_products'],
    })

    const stranger = new TokenCipher({ master: Buffer.alloc(32, 9).toString('base64') })
    await expect(makeConnectionStore(harness.db, stranger).readToken(accountId)).rejects.toThrow()
  })

  it('answers with nothing for an account that has not connected', async () => {
    expect(await makeConnectionStore(harness.db, cipher).readToken(accountId)).toBeUndefined()
    expect(await makeConnectionStore(harness.db, cipher).read(accountId)).toBeUndefined()
  })
})

describe('the domain a store belongs to', () => {
  it('is found by the store name a webhook names', async () => {
    await makeConnectionStore(harness.db, cipher).save({
      accountId,
      shopHandle: 'acme',
      accessToken: 'shpat_x',
      grantedScopes: ['read_products'],
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
