import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '@sortiva/db'
import {
  databaseAvailable,
  insertAccount,
  setupTestDb,
  truncateAll,
  type TestDb,
} from '@sortiva/db/testing'
import { accountLifecycleGate } from './gate'

/**
 * Vacation mode, billing state and a requested deletion, read out of a real
 * database and turned into one answer.
 *
 * Read together on purpose: three separate round trips could see the account
 * from three different moments, and "may this run" has to be answered as of one.
 */

let harness: TestDb
let db: Db

beforeAll(async () => {
  if (!(await databaseAvailable())) {
    throw new Error('Postgres is not reachable. Run `pnpm db:up` before the test suite.')
  }
  harness = await setupTestDb('lifecycle_gate')
  db = harness.db
}, 60_000)

afterAll(async () => {
  await harness?.close()
})

beforeEach(async () => {
  await truncateAll(harness.pool)
})

async function paidUpAccount(email: string): Promise<string> {
  const accountId = await insertAccount(harness.pool, email)
  await harness.pool.query(
    "insert into subscriptions (account_id, stripe_subscription_id, price_id, status) values ($1, $2, 'price_1', 'active')",
    [accountId, `sub_${email}`],
  )
  return accountId
}

describe('what an account may do, read from its own rows', () => {
  it('lets a paid-up account with no settings row do everything', async () => {
    // No settings row at all is the state right after signup, and vacation mode
    // is something a merchant switches on.
    const accountId = await paidUpAccount('fresh@example.com')
    expect(await accountLifecycleGate(db, accountId)).toMatchObject({
      generationAllowed: true,
      publishingAllowed: true,
      readAllowed: true,
      stoppedBy: [],
    })
  })

  it('stops writing but not reading while vacation mode is on', async () => {
    const accountId = await paidUpAccount('away@example.com')
    await harness.pool.query(
      'insert into account_settings (account_id, vacation_mode) values ($1, true)',
      [accountId],
    )
    expect(await accountLifecycleGate(db, accountId)).toMatchObject({
      generationAllowed: false,
      publishingAllowed: false,
      catalogSyncAllowed: true,
      searchReportingAllowed: true,
      readAllowed: true,
      stoppedBy: ['vacation'],
    })
  })

  it('stops writing but not reading when the payment failed', async () => {
    const accountId = await insertAccount(harness.pool, 'unpaid@example.com')
    await harness.pool.query(
      "insert into subscriptions (account_id, stripe_subscription_id, price_id, status) values ($1, 'sub_unpaid', 'price_1', 'past_due')",
      [accountId],
    )
    expect(await accountLifecycleGate(db, accountId)).toMatchObject({
      generationAllowed: false,
      readAllowed: true,
      stoppedBy: ['billing'],
    })
  })

  it('stops everything once deletion has been asked for', async () => {
    const accountId = await paidUpAccount('leaving@example.com')
    await harness.pool.query('update accounts set deleted_at = now() where id = $1', [accountId])
    expect(await accountLifecycleGate(db, accountId)).toMatchObject({
      generationAllowed: false,
      publishingAllowed: false,
      catalogSyncAllowed: false,
      searchReportingAllowed: false,
      readAllowed: false,
      stoppedBy: ['deletion_requested'],
    })
  })

  it('closes every gate for an account that has already been erased', async () => {
    // The dispatcher's race: work queued a week ago for an account the sweep
    // erased last night.
    const gate = await accountLifecycleGate(db, '00000000-0000-0000-0000-000000000000')
    expect(gate.generationAllowed).toBe(false)
    expect(gate.readAllowed).toBe(false)
  })
})
