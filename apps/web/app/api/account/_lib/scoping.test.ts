import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { accountResponseSchema } from '@sortiva/core'
import { databaseAvailable, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { withAccount } from '../../auth/_lib/session'
import { makeAccountRouteHandler } from './handler'

/**
 * tech §3 — "every query is `WHERE account_id = session.account_id`, enforced by
 * a repository layer that requires the account scope parameter".
 *
 * This drives the real route: the real `withAccount` wrapper, the real handler,
 * the real repositories, a real Postgres. Only the session reader is
 * substituted, because Auth.js's cookie is not what is under test here — the
 * Auth.js callbacks that put the account id on the session have their own test
 * in `../../auth/_lib/config.test.ts`.
 */

const available = await databaseAvailable()

describe.skipIf(!available)('GET /api/account is scoped to the session account', () => {
  let harness: TestDb
  let accountA: string
  let accountB: string

  beforeAll(async () => {
    harness = await setupTestDb('web_account_scoping')
  })

  afterAll(async () => {
    await harness.close()
  })

  beforeEach(async () => {
    await truncateAll(harness.pool)
    const { rows } = await harness.pool.query<{ id: string; email: string }>(
      "INSERT INTO accounts (email) VALUES ('a@example.com'), ('b@example.com') RETURNING id, email",
    )
    accountA = rows.find((r) => r.email === 'a@example.com')!.id
    accountB = rows.find((r) => r.email === 'b@example.com')!.id

    await harness.pool.query(
      "INSERT INTO domains (account_id, domain_normalized, platform, state) VALUES ($1, 'alpha.com', 'shopify', 'ingesting'), ($2, 'beta.com', 'shopify', 'ready_for_planning')",
      [accountA, accountB],
    )
    await harness.pool.query(
      "INSERT INTO shopify_conns (account_id, shop_handle, access_token, granted_scopes) VALUES ($1, 'beta', 'ciphertext', ARRAY['read_products','write_content'])",
      [accountB],
    )
  })

  function route(sessionAccountId: string | null) {
    return withAccount(makeAccountRouteHandler(harness.db), async () => sessionAccountId)
  }

  it('returns only the session account rows, never the other account rows', async () => {
    const response = await route(accountA)(new Request('http://localhost/api/account'), undefined)
    expect(response.status).toBe(200)

    const body = accountResponseSchema.parse(await response.json())
    expect(body.accountId).toBe(accountA)
    expect(body.email).toBe('a@example.com')
    expect(body.domain).toEqual({ normalized: 'alpha.com', state: 'ingesting', platform: 'shopify' })

    // Account B's rows exist in the same tables and none of them leaked.
    const serialised = JSON.stringify(body)
    expect(serialised).not.toContain('beta.com')
    expect(serialised).not.toContain(accountB)
    expect(body.connections.shopify).toBe('none')
  })

  it('serves each account its own rows from the same handler', async () => {
    const asB = await route(accountB)(new Request('http://localhost/api/account'), undefined)
    const body = accountResponseSchema.parse(await asB.json())

    expect(body.accountId).toBe(accountB)
    expect(body.domain?.normalized).toBe('beta.com')
    // main §6.2, invariant 21 — the write grant is visible as a distinct state.
    expect(body.connections.shopify).toBe('read_write')
  })

  it('answers 401 with a machine-readable code when there is no session', async () => {
    const response = await route(null)(new Request('http://localhost/api/account'), undefined)
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      error: { code: 'unauthenticated', message: 'Sign in to continue.' },
    })
  })

  it('reads are not gated on billing state (invariant 16)', async () => {
    await harness.pool.query(
      "INSERT INTO subscriptions (account_id, stripe_subscription_id, price_id, status) VALUES ($1, 'sub_canceled', 'price_x', 'canceled')",
      [accountA],
    )
    const response = await route(accountA)(new Request('http://localhost/api/account'), undefined)

    expect(response.status).toBe(200)
    const body = accountResponseSchema.parse(await response.json())
    expect(body.subscription.status).toBe('canceled')
  })

  it('reports the service as paused when a kill switch is tripped (main §14.5)', async () => {
    await harness.pool.query(
      "INSERT INTO ops_flags (scope, flag, actor, reason, tripped_by) VALUES ('global', 'pause_all', 'ops', 'test', 'manual')",
    )
    const response = await route(accountA)(new Request('http://localhost/api/account'), undefined)
    const body = accountResponseSchema.parse(await response.json())

    expect(body.servicePaused).toBe(true)
  })
})
