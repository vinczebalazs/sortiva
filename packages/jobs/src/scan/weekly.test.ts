import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import {
  createLogger,
  weeklyScanAllowedFor,
  type LogRecord,
  type NotificationEmitter,
} from '@sortiva/core'
import { MockSeoDataProvider } from '@sortiva/providers/seo/mock'
import { accountScope, findSignalRun, listSignalRuns, upsertStorePages } from '@sortiva/db'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { accountLifecycleGate } from '../runtime/gate'
import { sweepWeeklyScans, weeklyRunId, type WeeklyScanDeps } from './weekly'

const available = await databaseAvailable()

/**
 * Which stores the Monday sweep spends money on.
 *
 * A scan buys results pages from the search-data vendor, per store, per week,
 * so a store nobody is paying for is a bill for nothing. Three states stop it:
 * the subscription is not active, the merchant switched vacation mode on, or
 * deletion has been asked for.
 *
 * Every test here asserts on the `signal_runs` row rather than on a spy,
 * because that row is the product's own record that a store was analysed: no
 * row means the store was genuinely passed over, not merely that some inner
 * call happened to be cheap.
 */

const MONDAY = new Date('2026-09-07T07:00:00Z')
const TUESDAY = new Date('2026-09-08T07:00:00Z')
/** `scanLocalDay` in UTC for `MONDAY` — what the run id is keyed on. */
const MONDAY_LOCAL_DAY = '2026-09-07'

describe.skipIf(!available)('the weekly sweep and the stores it will not spend on', () => {
  let ctx: TestDb
  let pool: pg.Pool
  let logs: LogRecord[]
  let emitted: string[]

  beforeAll(async () => {
    ctx = await setupTestDb('weekly-scan-sweep')
    pool = ctx.pool
  }, 60_000)

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(pool)
    logs = []
    emitted = []
  })

  const notifications: NotificationEmitter = {
    emit: async (_type, _refs, dedupeKey) => {
      emitted.push(dedupeKey)
      return { created: true }
    },
  }

  function deps(now: Date): WeeklyScanDeps {
    return {
      db: ctx.db,
      pool,
      seo: new MockSeoDataProvider({}),
      capture: { capture: () => undefined },
      now: () => now,
      logger: createLogger({ sink: (line) => logs.push(JSON.parse(line) as LogRecord), minLevel: 'debug' }),
      notifications,
    }
  }

  /** A store with enough on it that a scan would find something to say. */
  async function storeWithPages(email: string): Promise<string> {
    const accountId = await insertAccount(pool, email)
    await upsertStorePages(ctx.db, accountScope(accountId), [
      {
        url: 'https://shop.example/collections/trail-shoes',
        pageType: 'collection',
        handle: 'trail-shoes',
        shopifyId: 'gid://shopify/Collection/1',
        title: 'Trail Running Shoes',
        seoTitle: null,
        seoDescription: null,
        headings: [],
        bodyHtml: null,
        outboundInternalLinks: [],
        familyIds: [],
        checksum: 'a',
      },
    ])
    return accountId
  }

  async function payUp(accountId: string, status = 'active'): Promise<void> {
    await pool.query(
      'insert into subscriptions (account_id, stripe_subscription_id, price_id, status) values ($1, $2, $3, $4)',
      [accountId, `sub_${accountId}`, 'price_1', status],
    )
  }

  async function wasScanned(accountId: string): Promise<boolean> {
    const run = await findSignalRun(ctx.db, accountScope(accountId), weeklyRunId(accountId, MONDAY_LOCAL_DAY))
    return run?.finishedAt != null
  }

  function skipLinesFor(accountId: string): LogRecord[] {
    return logs.filter(
      (line) => line.msg === 'weekly_scan.skipped_for_account_state' && line.account_id === accountId,
    )
  }

  it('scans a paid-up store on its Monday', async () => {
    const accountId = await storeWithPages('paid@example.com')
    await payUp(accountId)

    const outcome = await sweepWeeklyScans(deps(MONDAY))

    expect(await wasScanned(accountId)).toBe(true)
    expect(outcome).toMatchObject({ considered: 1, scanned: 1, skipped: 0 })
    expect(skipLinesFor(accountId)).toEqual([])
  })

  it('does not scan a store whose payment has failed', async () => {
    const accountId = await storeWithPages('past-due@example.com')
    await payUp(accountId, 'past_due')

    const outcome = await sweepWeeklyScans(deps(MONDAY))

    expect(await wasScanned(accountId)).toBe(false)
    expect(outcome).toMatchObject({ scanned: 0, skipped: 1 })
    expect(outcome.skippedByReason.billing).toBe(1)
  })

  it('does not scan a store that has never subscribed', async () => {
    const accountId = await storeWithPages('never-paid@example.com')

    const outcome = await sweepWeeklyScans(deps(MONDAY))

    expect(await wasScanned(accountId)).toBe(false)
    expect(outcome.skippedByReason.billing).toBe(1)
  })

  it('does not scan a paid-up store whose merchant is away', async () => {
    const accountId = await storeWithPages('away@example.com')
    await payUp(accountId)
    await pool.query('insert into account_settings (account_id, vacation_mode) values ($1, true)', [accountId])

    const outcome = await sweepWeeklyScans(deps(MONDAY))

    expect(await wasScanned(accountId)).toBe(false)
    expect(outcome.skippedByReason.vacation).toBe(1)
  })

  it('does not scan a store that has asked to be deleted, by either of the two things that stop it', async () => {
    const accountId = await storeWithPages('leaving@example.com')
    await payUp(accountId)
    await pool.query('update accounts set deleted_at = now() where id = $1', [accountId])

    const outcome = await sweepWeeklyScans(deps(MONDAY))

    expect(await wasScanned(accountId)).toBe(false)
    // Two independent mechanisms answer this one, and the test holds both,
    // because only the first is load-bearing today and a change to it would
    // otherwise go unnoticed.
    //
    // First: the account list this sweep reads already leaves out accounts
    // marked for deletion, so such a store is never even considered.
    expect(outcome.considered).toBe(0)
    // Second: were it considered, the gate would stop it anyway.
    expect(weeklyScanAllowedFor(await accountLifecycleGate(ctx.db, accountId))).toBe(false)
  })

  it('names the store it passed over and why, so a skip is never silent', async () => {
    const away = await storeWithPages('logged-away@example.com')
    await payUp(away)
    await pool.query('insert into account_settings (account_id, vacation_mode) values ($1, true)', [away])

    await sweepWeeklyScans(deps(MONDAY))

    const [line] = skipLinesFor(away)
    expect(line).toBeDefined()
    expect(line!.reasons).toEqual(['vacation'])
    // Ids and reasons only. A log line about a store must not carry the store's
    // own words.
    expect(JSON.stringify(line)).not.toContain('Trail Running Shoes')

    const summary = logs.filter((l) => l.msg === 'weekly_scan_sweep_complete').at(-1)
    expect(summary).toMatchObject({ considered: 1, scanned: 0, skipped: 1 })
    expect(summary!.skipped_by_reason).toMatchObject({ vacation: 1, billing: 0, deletion_requested: 0 })
  })

  it('counts a store stopped for two reasons under both', async () => {
    const accountId = await storeWithPages('away-and-unpaid@example.com')
    await payUp(accountId, 'canceled')
    await pool.query('insert into account_settings (account_id, vacation_mode) values ($1, true)', [accountId])

    const outcome = await sweepWeeklyScans(deps(MONDAY))

    expect(outcome.skipped).toBe(1)
    expect(outcome.skippedByReason).toMatchObject({ billing: 1, vacation: 1 })
    expect(skipLinesFor(accountId)[0]!.reasons).toEqual(['billing', 'vacation'])
  })

  it('leaves a paid-up store alone next to a skipped one', async () => {
    const paid = await storeWithPages('both-paid@example.com')
    await payUp(paid)
    const unpaid = await storeWithPages('both-unpaid@example.com')

    const outcome = await sweepWeeklyScans(deps(MONDAY))

    expect(await wasScanned(paid)).toBe(true)
    expect(await wasScanned(unpaid)).toBe(false)
    expect(outcome).toMatchObject({ considered: 2, scanned: 1, skipped: 1 })
  })

  it('does not count a skip on a day that is not the store\'s Monday', async () => {
    const accountId = await storeWithPages('tuesday@example.com')

    const outcome = await sweepWeeklyScans(deps(TUESDAY))

    // Nothing was passed over: nothing was due. Counting every unpaid store
    // every hour of every day would drown the one number that matters.
    expect(outcome).toMatchObject({ considered: 1, scanned: 0, skipped: 0 })
    expect(skipLinesFor(accountId)).toEqual([])
  })

  it('takes nothing away from a skipped store that was scanned while it was paying', async () => {
    const accountId = await storeWithPages('lapsed@example.com')
    await payUp(accountId)
    await sweepWeeklyScans(deps(MONDAY))
    const before = await listSignalRuns(ctx.db, accountScope(accountId))
    expect(before.length).toBe(1)

    await pool.query("update subscriptions set status = 'canceled' where account_id = $1", [accountId])
    const nextMonday = new Date('2026-09-14T07:00:00Z')
    await sweepWeeklyScans(deps(nextMonday))

    // The history the merchant can still read is untouched: the sweep adds
    // nothing and removes nothing. Read access is never revoked by billing.
    const after = await listSignalRuns(ctx.db, accountScope(accountId))
    expect(after.map((r) => r.runId)).toEqual(before.map((r) => r.runId))
  })

  it('tells nobody about opportunities it did not look for', async () => {
    const accountId = await storeWithPages('quiet@example.com')

    await sweepWeeklyScans(deps(MONDAY))

    expect(emitted).toEqual([])
    expect(accountId).toBeTruthy()
  })
})
