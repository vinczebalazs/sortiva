import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { accountScope, systemScope } from './scope'
import { findShopifyConnForAccount } from './repositories/accounts'
import { transitionDomainState } from './repositories/domains'
import {
  findAccountByShopHandle,
  markShopifyConnectionInvalid,
  readShopifyTokenCipher,
  saveShopifyConnection,
  setDomainPlatform,
  shopifyConnectionState,
} from './repositories/connections'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from './testing'

/**
 * The store connection against a real Postgres, because the two behaviours that
 * matter here are both database behaviours: reconnecting has to land on the
 * same row rather than a second one, and the moment a connection broke has to
 * stay put once recorded — the reconnect notification is deduplicated on it, so
 * a moving timestamp would ring the bell twice.
 */

let harness: TestDb
let accountId: string

/**
 * A moment after the connection was made.
 *
 * Nothing here is about clock arithmetic: a refusal is only believed when it
 * happened to the connection that exists, so every test that reports one has to
 * date it after the connection it is reporting about.
 */
function after(connectedAt: Date, millis = 1_000): Date {
  return new Date(connectedAt.getTime() + millis)
}

beforeAll(async () => {
  if (!(await databaseAvailable())) {
    throw new Error('Postgres is not reachable. Run `pnpm db:up` before the test suite.')
  }
  harness = await setupTestDb('shopify_conns')
}, 60_000)

afterAll(async () => {
  await harness?.close()
})

beforeEach(async () => {
  await truncateAll(harness.pool)
  accountId = await insertAccount(harness.pool, `store-${Date.now()}@example.com`)
  await harness.pool.query('INSERT INTO domains (account_id, domain_normalized) VALUES ($1, $2)', [
    accountId,
    'acme.example',
  ])
})

describe('storing a Shopify connection', () => {
  it('holds ciphertext and hands the same ciphertext back', async () => {
    const scope = accountScope(accountId)
    const cipher = 'v1.abcd1234.wrapped.iv.tag.iv.tag.ciphertext'

    await saveShopifyConnection(harness.db, scope, {
      shopHandle: 'acme',
      accessTokenCipher: cipher,
      grantedScopes: ['read_products', 'read_orders'],
    })

    expect(await readShopifyTokenCipher(harness.db, scope)).toBe(cipher)

    // Nothing resembling a Shopify token is in the column.
    const { rows } = await harness.pool.query<{ access_token: string }>(
      'SELECT access_token FROM shopify_conns WHERE account_id = $1',
      [accountId],
    )
    expect(rows[0]!.access_token).toBe(cipher)
    expect(rows[0]!.access_token).not.toMatch(/^shpat_/)
  })

  it('records exactly which permissions Shopify granted', async () => {
    const scope = accountScope(accountId)
    await saveShopifyConnection(harness.db, scope, {
      shopHandle: 'acme',
      accessTokenCipher: 'cipher',
      grantedScopes: ['read_products', 'read_orders', 'read_content'],
    })

    const row = await findShopifyConnForAccount(harness.db, scope)
    expect(row?.grantedScopes).toEqual(['read_products', 'read_orders', 'read_content'])
    expect(row?.grantedScopes.some((s) => s.startsWith('write_'))).toBe(false)
  })

  it('reconnecting replaces the connection instead of making a second one', async () => {
    const scope = accountScope(accountId)
    const first = await saveShopifyConnection(harness.db, scope, {
      shopHandle: 'acme',
      accessTokenCipher: 'first',
      grantedScopes: ['read_products'],
    })
    await markShopifyConnectionInvalid(harness.db, scope, after(first.connectedAt))

    await saveShopifyConnection(harness.db, scope, {
      shopHandle: 'acme',
      accessTokenCipher: 'second',
      grantedScopes: ['read_products', 'read_orders'],
    })

    const { rows } = await harness.pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM shopify_conns WHERE account_id = $1',
      [accountId],
    )
    expect(rows[0]!.n).toBe('1')
    expect(await readShopifyTokenCipher(harness.db, scope)).toBe('second')
    expect(await shopifyConnectionState(harness.db, scope)).toBe('connected')
  })
})

describe('when Shopify stops accepting our token', () => {
  it('keeps the first moment, so a worker running twice cannot ring the bell twice', async () => {
    const scope = accountScope(accountId)
    const conn = await saveShopifyConnection(harness.db, scope, {
      shopHandle: 'acme',
      accessTokenCipher: 'cipher',
      grantedScopes: ['read_products'],
    })

    const brokeAt = after(conn.connectedAt, 60_000)
    const first = await markShopifyConnectionInvalid(harness.db, scope, brokeAt)
    const second = await markShopifyConnectionInvalid(harness.db, scope, after(conn.connectedAt, 120_000))

    expect(first?.toISOString()).toBe(brokeAt.toISOString())
    expect(second?.toISOString()).toBe(first?.toISOString())
  })

  it('never reports a connection made after the failure as broken', async () => {
    // A merchant reconnects while the job that failed on the old token is still
    // winding down. That job then reports a refusal that happened *before* the
    // new connection existed. Believing it would put the reconnect banner back
    // up on a store that had just this second fixed itself, and the merchant
    // would reconnect again to no effect.
    const scope = accountScope(accountId)
    const conn = await saveShopifyConnection(harness.db, scope, {
      shopHandle: 'acme',
      accessTokenCipher: 'cipher',
      grantedScopes: ['read_products'],
    })

    const beforeTheReconnect = new Date(conn.connectedAt.getTime() - 60_000)
    expect(await markShopifyConnectionInvalid(harness.db, scope, beforeTheReconnect)).toBeUndefined()
    expect(await shopifyConnectionState(harness.db, scope)).toBe('connected')

    // And a refusal of the connection that actually exists is still recorded.
    const brokeAt = after(conn.connectedAt, 60_000)
    expect((await markShopifyConnectionInvalid(harness.db, scope, brokeAt))?.toISOString()).toBe(
      brokeAt.toISOString(),
    )
    expect(await shopifyConnectionState(harness.db, scope)).toBe('lost')
  })

  it('is what tells the never-connected screen from the reconnect screen', async () => {
    const scope = accountScope(accountId)
    expect(await shopifyConnectionState(harness.db, scope)).toBe('never_connected')

    const conn = await saveShopifyConnection(harness.db, scope, {
      shopHandle: 'acme',
      accessTokenCipher: 'cipher',
      grantedScopes: ['read_products'],
    })
    expect(await shopifyConnectionState(harness.db, scope)).toBe('connected')

    await markShopifyConnectionInvalid(harness.db, scope, after(conn.connectedAt))
    expect(await shopifyConnectionState(harness.db, scope)).toBe('lost')
  })
})

describe('finding the store a webhook is about', () => {
  it('answers with the account holding that store, and nothing for a stranger', async () => {
    await saveShopifyConnection(harness.db, accountScope(accountId), {
      shopHandle: 'acme',
      accessTokenCipher: 'cipher',
      grantedScopes: ['read_products'],
    })
    const scope = systemScope('a Shopify webhook names the store and nothing else')

    expect(await findAccountByShopHandle(harness.db, scope, 'acme')).toBe(accountId)
    expect(await findAccountByShopHandle(harness.db, scope, 'someone-else')).toBeUndefined()
  })

  it('cannot attach one store to two accounts', async () => {
    const other = await insertAccount(harness.pool, 'other@example.com')
    await harness.pool.query('INSERT INTO domains (account_id, domain_normalized) VALUES ($1,$2)', [
      other,
      'other.example',
    ])
    await saveShopifyConnection(harness.db, accountScope(accountId), {
      shopHandle: 'acme',
      accessTokenCipher: 'cipher',
      grantedScopes: ['read_products'],
    })

    await expect(
      saveShopifyConnection(harness.db, accountScope(other), {
        shopHandle: 'acme',
        accessTokenCipher: 'cipher',
        grantedScopes: ['read_products'],
      }),
    ).rejects.toThrow()
  })
})

describe('the domain row detection writes', () => {
  it('records the platform and moves the store on, guarded', async () => {
    const scope = accountScope(accountId)
    await setDomainPlatform(harness.db, scope, 'shopify')

    const moved = await transitionDomainState(harness.db, scope, ['ingesting'], 'awaiting_shopify_auth')
    expect(moved?.state).toBe('awaiting_shopify_auth')
    expect(moved?.platform).toBe('shopify')

    // The same transition a second time matches no rows: whoever ran first won.
    expect(await transitionDomainState(harness.db, scope, ['ingesting'], 'awaiting_shopify_auth')).toBeUndefined()
  })

  it('a lost connection can interrupt a store part-way through onboarding', async () => {
    const scope = accountScope(accountId)
    await transitionDomainState(harness.db, scope, ['ingesting'], 'ready_for_planning')

    const moved = await transitionDomainState(
      harness.db,
      scope,
      ['ingesting', 'needs_confirmation', 'ready_for_planning'],
      'awaiting_shopify_auth',
    )
    expect(moved?.state).toBe('awaiting_shopify_auth')
  })

  it('never drags a parked store back into onboarding', async () => {
    const scope = accountScope(accountId)
    await setDomainPlatform(harness.db, scope, 'custom_unsupported')
    await transitionDomainState(harness.db, scope, ['ingesting'], 'unsupported')

    const moved = await transitionDomainState(
      harness.db,
      scope,
      ['ingesting', 'needs_confirmation', 'ready_for_planning'],
      'awaiting_shopify_auth',
    )
    expect(moved).toBeUndefined()
  })
})
