import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ACCOUNT_DELETION_FACTS, closeAccount, domainReleaseAt } from '@sortiva/core'
import { makeAccountLifecycleStore } from '@sortiva/db'
import { databaseAvailable, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { MockShopifyOAuthClient, MockStripeProvider } from '@sortiva/providers'
import { withAccount } from '../../../auth/_lib/session'
import { makeDeleteAccountHandler } from './handler'

/**
 * Deleting an account, driven through the real route wrapper, the real handler
 * and a real Postgres. Only the session and the three vendors are substituted.
 *
 * The five sentences the deletion screen shows are promises, and each is
 * checked as behaviour rather than as copy: no further charges, the articles
 * untouched, both grants handed back, the domain held for a week, the data
 * erased. The week and the erase belong to the sweep and are proved in
 * `packages/jobs/src/sweeps/retention.test.ts`; dropping the logged-out
 * preview's own row is proved in `packages/db/src/lifecycle.test.ts`, which is
 * where naming that table is allowed at all — nothing outside the preview may
 * read from it, and a test that says the word counts.
 */

const available = await databaseAvailable()

describe.skipIf(!available)('POST /api/account/delete', () => {
  let harness: TestDb
  let accountId: string
  let queued: string[]

  beforeAll(async () => {
    harness = await setupTestDb('web_account_delete')
  }, 60_000)

  afterAll(async () => {
    await harness.close()
  })

  beforeEach(async () => {
    await truncateAll(harness.pool)
    queued = []
    const { rows } = await harness.pool.query<{ id: string }>(
      "INSERT INTO accounts (email) VALUES ('leaving@example.com') RETURNING id",
    )
    accountId = rows[0]!.id
    await harness.pool.query(
      "INSERT INTO domains (account_id, domain_normalized, state) VALUES ($1, 'leaving.example', 'ready_for_planning')",
      [accountId],
    )
    await harness.pool.query(
      "INSERT INTO shopify_conns (account_id, shop_handle, access_token, granted_scopes) VALUES ($1, 'leaving', 'shpat_cipher', ARRAY['read_products'])",
      [accountId],
    )
    await harness.pool.query(
      "INSERT INTO subscriptions (account_id, stripe_subscription_id, price_id, status) VALUES ($1, 'sub_leaving', 'price_1', 'active')",
      [accountId],
    )
    await harness.pool.query(
      "INSERT INTO notifications (account_id, type, dedupe_key) VALUES ($1, 'article_published', 'a')",
      [accountId],
    )
    await harness.pool.query(
      "INSERT INTO email_sends (account_id, type, dedupe_key, template_version) VALUES ($1, 'article_published', 'a', 'v1')",
      [accountId],
    )
  })

  function route(sessionAccountId: string | null) {
    const handler = makeDeleteAccountHandler({
      database: harness.db,
      enqueue: async (_db, id) => {
        queued.push(id)
      },
    })
    return withAccount(handler, async () => sessionAccountId)
  }

  function post(body: unknown): Request {
    return new Request('http://localhost/api/account/delete', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    })
  }

  it('refuses without the typed confirmation', async () => {
    const response = await route(accountId)(post({ confirmation: 'delete' }), undefined)
    expect(response.status).toBe(400)
    const { rows } = await harness.pool.query('select deleted_at from accounts where id = $1', [
      accountId,
    ])
    expect(rows[0]!.deleted_at).toBeNull()
  })

  it('refuses a caller with no session', async () => {
    const response = await route(null)(post({ confirmation: 'DELETE' }), undefined)
    expect(response.status).toBe(401)
  })

  it('stamps the deletion and holds the domain for a week', async () => {
    const before = new Date()
    const response = await route(accountId)(post({ confirmation: 'DELETE' }), undefined)
    expect(response.status).toBe(200)

    const { rows } = await harness.pool.query<{ deleted_at: Date; release_after: Date }>(
      `select a.deleted_at, d.release_after
         from accounts a join domains d on d.account_id = a.id where a.id = $1`,
      [accountId],
    )
    const deletedAt = rows[0]!.deleted_at
    expect(deletedAt).not.toBeNull()
    expect(rows[0]!.release_after.getTime()).toBeGreaterThanOrEqual(
      domainReleaseAt(before).getTime() - 5_000,
    )
  })

  it('marks the store connection dead, so a webhook stops resolving to this account', async () => {
    await route(accountId)(post({ confirmation: 'DELETE' }), undefined)
    const { rows } = await harness.pool.query<{ invalidated_at: Date | null }>(
      'select invalidated_at from shopify_conns where account_id = $1',
      [accountId],
    )
    expect(rows[0]!.invalidated_at).not.toBeNull()
  })

  it('queues the vendor work rather than doing it while the merchant waits', async () => {
    await route(accountId)(post({ confirmation: 'DELETE' }), undefined)
    expect(queued).toEqual([accountId])
  })

  it('answers success, and queues nothing more, when it has already happened', async () => {
    await route(accountId)(post({ confirmation: 'DELETE' }), undefined)
    const second = await route(accountId)(post({ confirmation: 'DELETE' }), undefined)
    expect(second.status).toBe(200)
    expect(queued).toHaveLength(1)
  })

  it('cancels the subscription once and hands both grants back, when the job runs', async () => {
    await route(accountId)(post({ confirmation: 'DELETE' }), undefined)

    const stripe = new MockStripeProvider()
    const shopify = new MockShopifyOAuthClient()
    const googleRevoked: string[] = []
    const store = makeAccountLifecycleStore({ database: harness.db })

    const result = await closeAccount(
      {
        store,
        billing: { cancelNow: (id) => stripe.cancelSubscription(id) },
        revoker: {
          revokeShopify: ({ shopHandle, accessToken }) =>
            shopify.revokeAccess({ shop: shopHandle, accessToken }),
          revokeGoogle: async (token) => {
            googleRevoked.push(token)
          },
        },
      },
      { accountId },
    )

    expect(result).toMatchObject({ kind: 'closed', subscriptionCancelled: true })
    expect(stripe.cancelled).toEqual(['sub_leaving'])
    expect(shopify.revocations).toEqual([{ shop: 'leaving', accessToken: 'shpat_cipher' }])
    expect(googleRevoked, 'no Search Console connection to hand back').toEqual([])

    const { rows } = await harness.pool.query('select 1 from shopify_conns where account_id = $1', [
      accountId,
    ])
    expect(rows, 'the token is destroyed once the vendor has been told').toEqual([])
  })

  it('cascades the bell and the mail records when the account is finally erased', async () => {
    await route(accountId)(post({ confirmation: 'DELETE' }), undefined)
    await harness.pool.query('delete from accounts where id = $1', [accountId])
    for (const table of ['notifications', 'email_sends', 'domains']) {
      const { rows } = await harness.pool.query(`select 1 from ${table}`)
      expect(rows, `${table} outlived the account`).toEqual([])
    }
  })

  it('states the five facts the screen has to show before this is reachable', () => {
    expect(ACCOUNT_DELETION_FACTS).toHaveLength(5)
  })
})
