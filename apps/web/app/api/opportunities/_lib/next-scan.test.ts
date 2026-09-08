import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  ACCOUNT_PAUSED_FLAG,
  ALL_WORK_PAUSED_FLAG,
  listOpportunitiesResponseSchema,
  weeklyScanRunId,
} from '@sortiva/core'
import { accountScope, systemScope, tripAccountFlag, tripGlobalFlag, writeSignalRun } from '@sortiva/db'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { withAccount } from '../../auth/_lib/session'
import { makeListOpportunitiesHandler } from './handlers'

const available = await databaseAvailable()

/** A Wednesday. Deliberately mid-week, so an answer of "next Monday" is a real prediction rather than "today". */
const WEDNESDAY = new Date('2026-09-09T12:00:00.000Z')
/** The Monday before it. */
const MONDAY = new Date('2026-09-07T12:00:00.000Z')

const RULES_VERSION = 'a'.repeat(64)

/**
 * What a merchant with nothing to act on is told about when that changes.
 *
 * The header ("last scan ... next scan ...") and the empty-state sentence both
 * render from this one field, so these tests are the only place either of them
 * can be wrong about.
 *
 * The cases that matter most here are the ones that answer **nothing**. A test
 * that only checks a healthy store passes just as happily on a build that
 * promises every store a scan, including the ones we have stopped working for.
 */
describe.skipIf(!available)('GET /api/opportunities - when the next scan is, and who is told nothing', () => {
  let harness: TestDb
  let accountId: string

  beforeAll(async () => {
    harness = await setupTestDb('web_next_scan')
  })

  afterAll(async () => {
    await harness.close()
  })

  beforeEach(async () => {
    await truncateAll(harness.pool)
    accountId = await insertAccount(harness.pool, 'next-scan@example.com')
  })

  /** Paid up, so the engine is running. Without this an account has no subscription row at all and is not entitled. */
  async function entitle(): Promise<void> {
    await harness.pool.query(
      `INSERT INTO subscriptions (account_id, stripe_subscription_id, price_id, status) VALUES ($1, 'sub_next_scan', 'price_1', 'active')`,
      [accountId],
    )
  }

  async function setSettings(input: { timezone?: string; vacationMode?: boolean }): Promise<void> {
    await harness.pool.query(
      `INSERT INTO account_settings (account_id, timezone, vacation_mode) VALUES ($1, $2, $3)
       ON CONFLICT (account_id) DO UPDATE SET timezone = EXCLUDED.timezone, vacation_mode = EXCLUDED.vacation_mode`,
      [accountId, input.timezone ?? 'UTC', input.vacationMode ?? false],
    )
  }

  async function seedWeeklyRun(localMonday: string, finishedAt: string): Promise<void> {
    await writeSignalRun(harness.db, accountScope(accountId), {
      runId: weeklyScanRunId(accountId, localMonday),
      kind: 'weekly',
      rulesVersion: RULES_VERSION,
      signalsEvaluated: 5,
      opportunitiesCreated: 0,
      opportunitiesUpdated: 0,
      opportunitiesExpired: 0,
      startedAt: new Date(`${localMonday}T00:00:00.000Z`),
      finishedAt: new Date(finishedAt),
    })
  }

  async function read(now: Date = WEDNESDAY) {
    const route = withAccount(
      makeListOpportunitiesHandler({ db: harness.db, now: () => now }),
      async () => accountId,
    )
    const response = await route(new Request('http://localhost/api/opportunities'), undefined)
    expect(response.status).toBe(200)
    return listOpportunitiesResponseSchema.parse(await response.json())
  }

  it('a store whose weekly scan is due is given a real time, and it is that store own next Monday', async () => {
    await entitle()
    await setSettings({ timezone: 'UTC' })

    const body = await read()

    expect(body.nextScanAt).toBe('2026-09-14T00:00:00.000Z')
  })

  it('the answer follows the store own clock, not a cadence - Auckland is scanned before London', async () => {
    await entitle()
    await setSettings({ timezone: 'Pacific/Auckland' })
    const auckland = await read()

    await setSettings({ timezone: 'Europe/London' })
    const london = await read()

    expect(auckland.nextScanAt).toBe('2026-09-13T12:00:00.000Z')
    expect(london.nextScanAt).toBe('2026-09-13T23:00:00.000Z')
    expect(Date.parse(auckland.nextScanAt!)).toBeLessThan(Date.parse(london.nextScanAt!))
  })

  it('this Monday having already been scanned moves the answer on to next Monday rather than repeating today', async () => {
    await entitle()
    await setSettings({ timezone: 'UTC' })
    await seedWeeklyRun('2026-09-07', '2026-09-07T00:04:00.000Z')

    const body = await read(MONDAY)

    expect(body.lastScanAt).toBe('2026-09-07T00:04:00.000Z')
    expect(body.nextScanAt).toBe('2026-09-14T00:00:00.000Z')
  })

  it('an unscanned Monday is answered with today, not next week', async () => {
    await entitle()
    await setSettings({ timezone: 'UTC' })

    const body = await read(new Date('2026-09-07T12:20:00.000Z'))

    expect(body.nextScanAt).toBe('2026-09-07T13:00:00.000Z')
  })

  /* -- Naming the day, not just the instant --------------------------------- */

  /**
   * The instant is correct and the *day* is not, unless whoever prints it knows
   * which calendar to print it in. Berlin is the smallest interesting case: one
   * hour east is enough to move the answer onto the previous date in UTC, so a
   * screen formatting this without the store timezone tells a Berlin merchant
   * their scan is on a Sunday.
   */
  it('carries the calendar the date must be read in, so a Berlin store is not told Sunday', async () => {
    await entitle()
    await setSettings({ timezone: 'Europe/Berlin' })

    const body = await read()

    expect(body.timezone).toBe('Europe/Berlin')

    // The whole point, stated as the two readings of one instant.
    const inUtc = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric' })
    const inStore = new Intl.DateTimeFormat('en-GB', {
      timeZone: body.timezone,
      weekday: 'long',
      day: 'numeric',
    })
    expect(inUtc.format(new Date(body.nextScanAt!))).toBe('Sunday 13')
    expect(inStore.format(new Date(body.nextScanAt!))).toBe('Monday 14')
  })

  it('a store that has never chosen a timezone gets a real answer rather than a missing one', async () => {
    await entitle()
    await setSettings({ timezone: 'UTC' })

    expect((await read()).timezone).toBe('UTC')
  })

  it('sends the calendar even to a store it promises no scan, because the last scan still has a date', async () => {
    await setSettings({ timezone: 'Pacific/Auckland' })
    await seedWeeklyRun('2026-09-07', '2026-09-07T00:04:00.000Z')

    const body = await read()

    expect(body.nextScanAt).toBeNull()
    expect(body.lastScanAt).toBe('2026-09-07T00:04:00.000Z')
    expect(body.timezone).toBe('Pacific/Auckland')
  })

  /* -- The stores that must not be promised anything ------------------------ */

  it('an account nobody is paying for is told nothing - and still reads everything else', async () => {
    await setSettings({ timezone: 'UTC' })

    const body = await read()

    expect(body.nextScanAt).toBeNull()
    // Invariant 16: billing takes away no read. The screen renders in full.
    expect(body.counts).toEqual({ open: 0, byAction: { CREATE: 0, OPTIMIZE: 0, REFRESH: 0, FIX: 0, HOLD: 0 } })
  })

  it('an account whose payment has lapsed is told nothing', async () => {
    await entitle()
    await harness.pool.query(`UPDATE subscriptions SET status = 'past_due' WHERE account_id = $1`, [accountId])
    await setSettings({ timezone: 'UTC' })

    expect((await read()).nextScanAt).toBeNull()
  })

  it('a merchant who has switched vacation mode on is told nothing', async () => {
    await entitle()
    await setSettings({ timezone: 'UTC', vacationMode: true })

    expect((await read()).nextScanAt).toBeNull()
  })

  it('a store this account is paused for is told nothing, though its last scan still shows', async () => {
    await entitle()
    await setSettings({ timezone: 'UTC' })
    await seedWeeklyRun('2026-08-31', '2026-08-31T00:04:00.000Z')
    await tripAccountFlag(harness.db, accountScope(accountId), {
      flag: ACCOUNT_PAUSED_FLAG,
      actor: 'test',
      reason: 'the store is paused',
      trippedBy: 'manual',
    })

    const body = await read()

    expect(body.nextScanAt).toBeNull()
    expect(body.lastScanAt).toBe('2026-08-31T00:04:00.000Z')
  })

  it('the whole product being paused reaches the screen as silence, not as a date', async () => {
    await entitle()
    await setSettings({ timezone: 'UTC' })
    await tripGlobalFlag(harness.db, systemScope('a test raising the master switch'), {
      flag: ALL_WORK_PAUSED_FLAG,
      actor: 'test',
      reason: 'incident',
      trippedBy: 'manual',
    })

    expect((await read()).nextScanAt).toBeNull()
  })

  it('an account on its way out is told nothing', async () => {
    await entitle()
    await setSettings({ timezone: 'UTC' })
    await harness.pool.query(`UPDATE accounts SET deleted_at = now() WHERE id = $1`, [accountId])

    expect((await read()).nextScanAt).toBeNull()
  })
})
