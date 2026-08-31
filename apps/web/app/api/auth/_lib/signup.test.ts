import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { provisionAccount, SIGNUP_COMPLETED_EVENT } from '@sortiva/core'
import { MockPosthogCapture } from '@sortiva/providers'
import { databaseAvailable, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { makeDbAccountStore } from './provisioning'

/**
 * main §4.1 — "an account is created with `domain = null`" — against real
 * Postgres, through the same store the Auth.js callback uses, so the unique
 * index rather than a mock decides what happens when two sign-ins race.
 */

const available = await databaseAvailable()

describe.skipIf(!available)('signup creates the account (main §4.1, §14.7)', () => {
  let harness: TestDb

  beforeAll(async () => {
    harness = await setupTestDb('web_signup')
  })

  afterAll(async () => {
    await harness.close()
  })

  beforeEach(async () => {
    await truncateAll(harness.pool)
  })

  it('writes an accounts row with no domain, and captures signup_completed', async () => {
    const capture = new MockPosthogCapture()
    const deps = { store: makeDbAccountStore(harness.db), capture }

    const { accountId, created } = await provisionAccount(deps, {
      email: 'founder@example.com',
      provider: 'google',
    })

    expect(created).toBe(true)

    const account = await harness.pool.query(
      'SELECT email, plan, stripe_customer_id FROM accounts WHERE id = $1',
      [accountId],
    )
    expect(account.rows).toEqual([
      { email: 'founder@example.com', plan: 'pro', stripe_customer_id: null },
    ])

    // main §4.1, §4.3 — `domain = null` is the absence of a `domains` row.
    const domains = await harness.pool.query('SELECT 1 FROM domains WHERE account_id = $1', [
      accountId,
    ])
    expect(domains.rowCount).toBe(0)

    expect(capture.of(SIGNUP_COMPLETED_EVENT)).toHaveLength(1)
    expect(capture.of(SIGNUP_COMPLETED_EVENT)[0]!.distinctId).toBe(accountId)
    expect(capture.of(SIGNUP_COMPLETED_EVENT)[0]!.groups).toEqual({})
  })

  it('two simultaneous sign-ins for one email create exactly one account', async () => {
    const capture = new MockPosthogCapture()
    const deps = { store: makeDbAccountStore(harness.db), capture }

    const results = await Promise.all([
      provisionAccount(deps, { email: 'race@example.com', provider: 'google' }),
      provisionAccount(deps, { email: 'race@example.com', provider: 'google' }),
    ])

    expect(results[0].accountId).toBe(results[1].accountId)
    expect(results.filter((r) => r.created)).toHaveLength(1)

    const { rowCount } = await harness.pool.query('SELECT 1 FROM accounts')
    expect(rowCount).toBe(1)
    expect(capture.of(SIGNUP_COMPLETED_EVENT)).toHaveLength(1)
  })

  it('a returning sign-in resolves to the same account and captures nothing', async () => {
    const capture = new MockPosthogCapture()
    const deps = { store: makeDbAccountStore(harness.db), capture }

    const first = await provisionAccount(deps, { email: 'founder@example.com', provider: 'google' })
    capture.reset()
    const again = await provisionAccount(deps, { email: 'founder@example.com', provider: 'google' })

    expect(again.accountId).toBe(first.accountId)
    expect(again.created).toBe(false)
    expect(capture.events).toEqual([])
  })
})
