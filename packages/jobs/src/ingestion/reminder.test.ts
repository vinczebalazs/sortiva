import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { StubNotificationEmitter } from '@sortiva/core'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { sweepOauthReminders } from './reminder'

/**
 * The nudge for a merchant who started connecting their store and walked away.
 *
 * Against a real database, because who qualifies is entirely a question the
 * database answers: still waiting, waiting long enough, and never connected.
 */

let harness: TestDb

async function store(options: {
  email: string
  state: string
  platform: string | null
  updatedAt: string
  connected?: boolean
}): Promise<string> {
  const accountId = await insertAccount(harness.pool, options.email)
  await harness.pool.query(
    `INSERT INTO domains (account_id, domain_normalized, state, platform, updated_at)
     VALUES ($1, $2, $3::domain_state, $4::domain_platform, $5)`,
    [accountId, `${options.email.split('@')[0]}.example`, options.state, options.platform, options.updatedAt],
  )
  if (options.connected) {
    await harness.pool.query(
      'INSERT INTO shopify_conns (account_id, shop_handle, access_token) VALUES ($1,$2,$3)',
      [accountId, options.email.split('@')[0], 'cipher'],
    )
  }
  return accountId
}

beforeAll(async () => {
  if (!(await databaseAvailable())) {
    throw new Error('Postgres is not reachable. Run `pnpm db:up` before the test suite.')
  }
  harness = await setupTestDb('oauth_reminder')
}, 60_000)

afterAll(async () => {
  await harness?.close()
})

beforeEach(async () => {
  await truncateAll(harness.pool)
})

describe('the reminder to finish connecting', () => {
  const now = new Date('2026-09-02T12:00:00Z')

  it('reaches a merchant who has been waiting more than a day', async () => {
    const accountId = await store({
      email: 'waiting@example.com',
      state: 'awaiting_shopify_auth',
      platform: 'shopify',
      updatedAt: '2026-09-01T09:00:00Z',
    })
    const notifications = new StubNotificationEmitter()

    const result = await sweepOauthReminders(harness.db, notifications, now)

    expect(result).toEqual({ considered: 1, notified: 1 })
    expect(notifications.emitted[0]).toMatchObject({ type: 'oauth_reminder', accountId })
  })

  it('leaves alone someone who only just got here', async () => {
    await store({
      email: 'fresh@example.com',
      state: 'awaiting_shopify_auth',
      platform: 'shopify',
      updatedAt: '2026-09-02T11:00:00Z',
    })

    expect(await sweepOauthReminders(harness.db, new StubNotificationEmitter(), now)).toEqual({
      considered: 0,
      notified: 0,
    })
  })

  it('leaves alone someone who did connect', async () => {
    await store({
      email: 'connected@example.com',
      state: 'awaiting_shopify_auth',
      platform: 'shopify',
      updatedAt: '2026-09-01T09:00:00Z',
      connected: true,
    })

    expect(await sweepOauthReminders(harness.db, new StubNotificationEmitter(), now)).toEqual({
      considered: 0,
      notified: 0,
    })
  })

  it('leaves alone a store parked because it is not Shopify', async () => {
    await store({
      email: 'parked@example.com',
      state: 'unsupported',
      platform: 'custom_unsupported',
      updatedAt: '2026-09-01T09:00:00Z',
    })

    expect(await sweepOauthReminders(harness.db, new StubNotificationEmitter(), now)).toEqual({
      considered: 0,
      notified: 0,
    })
  })

  it('says it once, however often the sweep runs', async () => {
    await store({
      email: 'waiting@example.com',
      state: 'awaiting_shopify_auth',
      platform: 'shopify',
      updatedAt: '2026-09-01T09:00:00Z',
    })
    const notifications = new StubNotificationEmitter()

    await sweepOauthReminders(harness.db, notifications, now)
    const second = await sweepOauthReminders(harness.db, notifications, now)

    expect(second).toEqual({ considered: 1, notified: 0 })
    expect(notifications.emitted).toHaveLength(1)
  })
})
