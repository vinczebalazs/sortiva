import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  accountScope,
  appendSpendEvent,
  isAccountFlagActive,
  isGlobalFlagActive,
  systemScope,
  tripAccountFlag,
  tripGlobalFlag,
  type Db,
} from '@sortiva/db'
import {
  databaseAvailable,
  insertAccount,
  setupTestDb,
  truncateAll,
  type TestDb,
} from '@sortiva/db/testing'
import {
  ACCOUNT_PAUSED_FLAG,
  ALL_WORK_PAUSED_FLAG,
  COUNT_FAILED_VENDOR_CALLS,
  ENRICHMENT_PAUSED_FLAG,
  PREVIEW_PAUSED_FLAG,
  silentLogger,
} from '@sortiva/core'
import { rules } from '@sortiva/rules'
import { evaluateSpendCaps } from './spend-caps'
import { mayAccountWorkRun } from '../runtime/gate'

/**
 * The brake, end to end: real spend rows in a real database, the real sweep,
 * and the real switch the dispatcher will read.
 *
 * Everything before this card existed and did nothing — the meter recorded
 * costs, the ceilings sat in configuration, and no code ever compared the two.
 * So these cases are written to fail if the comparison, the raising of the
 * switch, or the gate that reads it is removed; asserting that a function was
 * called would prove nothing here, because that was already true.
 */

const CAPS = rules().defaults.auto_trips
const HARD_CAP = CAPS.account_llm_spend.hard_cap_usd_per_day
const SEO_CAP = CAPS.dataforseo_spend.global_cap_usd_per_day
const PREVIEW_CAP = CAPS.preview_spend.global_cap_usd_per_day

const NOW = new Date('2026-09-01T12:00:00.000Z')
const MS_PER_DAY = 86_400_000

let harness: TestDb
let db: Db

beforeAll(async () => {
  if (!(await databaseAvailable())) {
    throw new Error('Postgres is not reachable. Run `pnpm db:up` before the test suite.')
  }
  harness = await setupTestDb('spend_caps')
  db = harness.db
}, 60_000)

afterAll(async () => {
  await harness?.close()
})

beforeEach(async () => {
  await truncateAll(harness.pool)
})

const system = systemScope('test setup')

async function anAccount(email: string): Promise<string> {
  return insertAccount(harness.pool, email)
}

async function spent(
  accountId: string,
  usd: number,
  options: { daysAgo?: number; outcome?: 'succeeded' | 'failed' } = {},
): Promise<void> {
  await appendSpendEvent(db, accountScope(accountId), {
    vendor: 'anthropic',
    callType: 'distill',
    usdCost: usd,
    cacheHit: false,
    outcome: options.outcome ?? 'succeeded',
    occurredAt: new Date(NOW.getTime() - (options.daysAgo ?? 0) * MS_PER_DAY),
  })
}

function sweep() {
  return evaluateSpendCaps(db, { now: () => NOW, log: silentLogger })
}

async function accountIsPaused(accountId: string): Promise<boolean> {
  return isAccountFlagActive(db, accountScope(accountId), ACCOUNT_PAUSED_FLAG)
}

describe("an account's daily model spend", () => {
  it('is paused once the day crosses the ceiling, and can then run nothing', async () => {
    const account = await anAccount('runaway@example.com')
    await spent(account, HARD_CAP + 1)

    expect(await accountIsPaused(account)).toBe(false)
    expect(await mayAccountWorkRun(db, account, silentLogger)).toEqual({ allowed: true })

    const report = await sweep()

    expect(report.accountsChecked).toBe(1)
    expect(report.trips).toHaveLength(1)
    expect(report.trips[0]?.raised).toBe(true)
    expect(report.trips[0]?.reason).toContain('daily ceiling')
    expect(await accountIsPaused(account)).toBe(true)
    expect(await mayAccountWorkRun(db, account, silentLogger)).toEqual({
      allowed: false,
      reason: 'paused',
      flag: ACCOUNT_PAUSED_FLAG,
    })
  })

  it('records who raised the switch, that it was automatic, and why', async () => {
    const account = await anAccount('audit@example.com')
    await spent(account, HARD_CAP + 2)
    await sweep()

    const { rows } = await harness.pool.query(
      `SELECT scope, flag, actor, reason, tripped_by, reset_at FROM ops_flags`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].scope).toBe('account')
    expect(rows[0].flag).toBe(ACCOUNT_PAUSED_FLAG)
    expect(rows[0].actor).toBe('spend_cap_sweep')
    expect(rows[0].tripped_by).toBe('auto')
    expect(rows[0].reason).toContain('$7.00')
    // An automatic trip never resets itself; a person has to look.
    expect(rows[0].reset_at).toBeNull()
  })

  it('leaves an account under the ceiling alone', async () => {
    const account = await anAccount('normal@example.com')
    await spent(account, HARD_CAP - 0.5)

    const report = await sweep()

    expect(report.trips).toEqual([])
    expect(await accountIsPaused(account)).toBe(false)
    expect(await mayAccountWorkRun(db, account, silentLogger)).toEqual({ allowed: true })
  })

  it('trips well under the ceiling when the day is unlike the account itself', async () => {
    const account = await anAccount('unusual@example.com')
    for (const daysAgo of [1, 2, 3, 4]) await spent(account, 0.1, { daysAgo })
    await spent(account, 2)

    const report = await sweep()

    expect(report.trips[0]?.reason).toContain('its own normal')
    expect(await accountIsPaused(account)).toBe(true)
  })

  it('does not count another account\'s spending against this one', async () => {
    const quiet = await anAccount('quiet@example.com')
    const loud = await anAccount('loud@example.com')
    await spent(loud, HARD_CAP + 1)
    await spent(quiet, 0.01)

    await sweep()

    expect(await accountIsPaused(loud)).toBe(true)
    expect(await accountIsPaused(quiet)).toBe(false)
  })

  it('ignores yesterday\'s spending when measuring today', async () => {
    const account = await anAccount('yesterday@example.com')
    await spent(account, HARD_CAP + 5, { daysAgo: 1 })

    const report = await sweep()

    expect(report.accountsChecked).toBe(0)
    expect(await accountIsPaused(account)).toBe(false)
  })

  it('raises one switch however often the sweep runs while the condition holds', async () => {
    const account = await anAccount('repeat@example.com')
    await spent(account, HARD_CAP + 1)

    await sweep()
    const second = await sweep()

    expect(second.trips[0]?.raised).toBe(false)
    const { rows } = await harness.pool.query(`SELECT count(*)::int AS n FROM ops_flags`)
    expect(rows[0].n).toBe(1)
  })

  it('counts calls that failed at the vendor, per the product-wide policy', async () => {
    const account = await anAccount('retrystorm@example.com')
    // A retry storm: every call rejected, every attempt still priced. This is
    // the shape of runaway the brake exists for, and it is invisible to a meter
    // that only counts calls that worked.
    await spent(account, HARD_CAP + 1, { outcome: 'failed' })

    await sweep()

    expect(await accountIsPaused(account)).toBe(COUNT_FAILED_VENDOR_CALLS)
  })
})

describe('the ceilings that cover everyone', () => {
  it('pauses enrichment when the day\'s search-data bill crosses its cap', async () => {
    const account = await anAccount('seo@example.com')
    await appendSpendEvent(db, accountScope(account), {
      vendor: 'dataforseo',
      callType: 'serp',
      usdCost: SEO_CAP + 1,
      cacheHit: false,
      outcome: 'succeeded',
      occurredAt: NOW,
    })

    const report = await sweep()

    expect(report.trips.map((t) => t.flag)).toContain(ENRICHMENT_PAUSED_FLAG)
    expect(await isGlobalFlagActive(db, system, ENRICHMENT_PAUSED_FLAG)).toBe(true)
    // Search-data spend is not model spend: the account itself keeps running.
    expect(await accountIsPaused(account)).toBe(false)
  })

  it('adds up search-data spend across accounts, because the bill is one bill', async () => {
    const half = SEO_CAP / 2 + 1
    for (const email of ['a@example.com', 'b@example.com']) {
      const account = await anAccount(email)
      await appendSpendEvent(db, accountScope(account), {
        vendor: 'dataforseo',
        callType: 'serp',
        usdCost: half,
        cacheHit: false,
        outcome: 'succeeded',
        occurredAt: NOW,
      })
    }

    await sweep()

    expect(await isGlobalFlagActive(db, system, ENRICHMENT_PAUSED_FLAG)).toBe(true)
  })

  it('pauses the logged-out preview on its own cap, and nothing else', async () => {
    await appendSpendEvent(db, system, {
      previewTarget: 'nike.com',
      vendor: 'anthropic',
      callType: 'preview',
      usdCost: PREVIEW_CAP + 1,
      cacheHit: false,
      outcome: 'succeeded',
      occurredAt: NOW,
    })

    const report = await sweep()

    expect(report.trips.map((t) => t.flag)).toEqual([PREVIEW_PAUSED_FLAG])
    expect(await isGlobalFlagActive(db, system, PREVIEW_PAUSED_FLAG)).toBe(true)
    expect(await isGlobalFlagActive(db, system, ALL_WORK_PAUSED_FLAG)).toBe(false)
  })

  it('does not let preview spend count against any account', async () => {
    const account = await anAccount('bystander@example.com')
    await spent(account, 0.01)
    await appendSpendEvent(db, system, {
      previewTarget: 'nike.com',
      vendor: 'anthropic',
      callType: 'preview',
      usdCost: PREVIEW_CAP + 1,
      cacheHit: false,
      outcome: 'succeeded',
      occurredAt: NOW,
    })

    await sweep()

    expect(await accountIsPaused(account)).toBe(false)
  })
})

describe('the gate a dispatcher calls', () => {
  it('stops every account while the master switch is up', async () => {
    const account = await anAccount('everyone@example.com')
    await tripGlobalFlag(db, system, {
      flag: ALL_WORK_PAUSED_FLAG,
      actor: 'operator',
      reason: 'incident',
      trippedBy: 'manual',
    })

    expect(await mayAccountWorkRun(db, account, silentLogger)).toEqual({
      allowed: false,
      reason: 'paused',
      flag: ALL_WORK_PAUSED_FLAG,
    })
  })

  it('reads the switch fresh, so a manual pause takes effect on the next job', async () => {
    const account = await anAccount('manual@example.com')
    expect(await mayAccountWorkRun(db, account, silentLogger)).toEqual({ allowed: true })

    await tripAccountFlag(db, accountScope(account), {
      flag: ACCOUNT_PAUSED_FLAG,
      actor: 'operator',
      reason: 'investigating',
      trippedBy: 'manual',
    })

    expect((await mayAccountWorkRun(db, account, silentLogger)).allowed).toBe(false)
  })

  it('refuses when the switches cannot be read at all', async () => {
    const broken = {
      select() {
        throw new Error('connection terminated unexpectedly')
      },
    } as unknown as Db

    const decision = await mayAccountWorkRun(broken, 'any-account', silentLogger)

    // Not "carry on": an unreadable switch is the one condition under which the
    // brakes would silently stop existing, and it is exactly when a runaway is
    // most plausible.
    expect(decision).toEqual({
      allowed: false,
      reason: 'unreadable',
      detail: 'connection terminated unexpectedly',
    })
  })
})
