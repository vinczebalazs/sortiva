import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { accountAttribution, previewAttribution } from '@sortiva/core'
import { DataForSeoProvider, MockPosthogCapture } from '@sortiva/providers'
import { PostgresCostLedger } from './spend'
import {
  RESTRICT_VIOLATION,
  databaseAvailable,
  insertAccount,
  pgErrorCode,
  setupTestDb,
  truncateAll,
  type TestDb,
} from './testing'

/**
 * The daily caps pause an account whose spend runs away, and the number they read comes from our own database rather
 * than from analytics — a kill switch has to work when the analytics vendor is
 * down or its events are delayed.
 *
 * Card `R2` made both paid wrappers hand every cost to a `CostLedger` on every
 * path. Until this adapter the only ledger in the repository was the deliberate
 * no-op, so the counter did not exist. These cases therefore assert the whole
 * chain — a real vendor wrapper, a real Postgres row — rather than the adapter
 * in isolation, on the success path *and* on a failure path, because "record on
 * failure too" is the point of D2 and is exactly what an isolated adapter test
 * would not notice losing.
 */

let harness: TestDb
let ledger: PostgresCostLedger

beforeAll(async () => {
  if (!(await databaseAvailable())) {
    throw new Error('Postgres is not reachable. Run `pnpm db:up` before the test suite.')
  }
  harness = await setupTestDb('spend_events')
  ledger = new PostgresCostLedger(harness.db)
}, 60_000)

afterAll(async () => {
  await harness?.close()
})

beforeEach(async () => {
  await truncateAll(harness.pool)
})

/** What the caps ask the table: what has this account spent today? */
async function rows() {
  const { rows } = await harness.pool.query(
    `SELECT account_id, preview_target, vendor, call_type, usd_cost::float8 AS usd_cost,
            cache_hit, outcome, occurred_at
     FROM spend_events ORDER BY occurred_at, call_type`,
  )
  return rows
}

function fakeFetch(body: unknown, status = 200) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  ) as unknown as typeof fetch
}

const LOCALE = { languageCode: 'da-DK', countryCode: 'DK' }

const VOLUME_RESPONSE = {
  tasks: [
    {
      status_code: 20000,
      result: [{ keyword: 'løbesko', search_volume: 1300, competition: 0.4, cpc: 0.7 }],
    },
  ],
}

describe('the DataForSEO wrapper writes spend_events through PostgresCostLedger', () => {
  function provider(fetchImpl: typeof fetch) {
    return new DataForSeoProvider({
      login: 'u',
      password: 'p',
      capture: new MockPosthogCapture(),
      ledger,
      fetchImpl,
    })
  }

  it('records a successful billable call against the account that made it', async () => {
    const accountId = await insertAccount(harness.pool, 'merchant@example.dk')

    const result = await provider(fakeFetch(VOLUME_RESPONSE)).keywordMetrics({
      keywords: ['løbesko'],
      locale: LOCALE,
      attribution: accountAttribution(accountId, 'example.dk'),
    })

    const [row] = await rows()
    expect(row).toBeDefined()
    expect(row.account_id).toBe(accountId)
    expect(row.preview_target).toBeNull()
    expect(row.vendor).toBe('dataforseo')
    expect(row.outcome).toBe('succeeded')
    expect(row.cache_hit).toBe(false)
    // The same figure the wrapper reported to its caller and to PostHog.
    expect(row.usd_cost).toBeCloseTo(result.meta.usdCost, 8)
    expect(row.usd_cost).toBeGreaterThan(0)
  })

  it('records a call the vendor rejected — the money left either way (remediation D2)', async () => {
    const accountId = await insertAccount(harness.pool, 'merchant@example.dk')

    await expect(
      provider(fakeFetch({ status_message: 'internal error' }, 500)).keywordMetrics({
        keywords: ['løbesko'],
        locale: LOCALE,
        attribution: accountAttribution(accountId, 'example.dk'),
      }),
    ).rejects.toThrow()

    const [row] = await rows()
    expect(row).toBeDefined()
    expect(row.outcome).toBe('failed')
    expect(row.account_id).toBe(accountId)
    expect(row.usd_cost).toBeGreaterThan(0)
  })

  it('attributes logged-out preview spend to the target domain, with no account', async () => {
    await provider(fakeFetch(VOLUME_RESPONSE)).keywordMetrics({
      keywords: ['løbesko'],
      locale: LOCALE,
      attribution: previewAttribution('nike.com'),
    })

    const [row] = await rows()
    expect(row.account_id).toBeNull()
    // The domain group is reserved for claimed domains — ten strangers
    // previewing nike.com is not Nike-the-account costing us money.
    expect(row.preview_target).toBe('nike.com')
  })
})

describe('PostgresCostLedger', () => {
  it('records a replay at zero rather than omitting it (§14.7 requirement 3)', async () => {
    const accountId = await insertAccount(harness.pool, 'merchant@example.dk')
    await ledger.record({
      attribution: accountAttribution(accountId, 'example.dk'),
      vendor: 'anthropic',
      callType: 'distill',
      usdCost: 0,
      cacheHit: true,
      outcome: 'succeeded',
    })

    const [row] = await rows()
    expect(row.cache_hit).toBe(true)
    expect(row.usd_cost).toBe(0)
  })

  it('keeps sub-cent costs out of exponent notation', async () => {
    const accountId = await insertAccount(harness.pool, 'merchant@example.dk')
    await ledger.record({
      attribution: accountAttribution(accountId),
      vendor: 'anthropic',
      callType: 'judge',
      usdCost: 0.00000123,
      cacheHit: false,
      outcome: 'succeeded',
    })

    const [row] = await rows()
    expect(row.usd_cost).toBeCloseTo(0.00000123, 8)
  })

  it('lets the database reject a paid cache hit rather than trusting the caller', async () => {
    const accountId = await insertAccount(harness.pool, 'merchant@example.dk')
    await expect(
      ledger.record({
        attribution: accountAttribution(accountId),
        vendor: 'dataforseo',
        callType: 'serp',
        usdCost: 0.03,
        cacheHit: true,
        outcome: 'succeeded',
      }),
    ).rejects.toThrow()
  })

  it('is append-only: a recorded cost is corrected by a second row, never an update', async () => {
    const accountId = await insertAccount(harness.pool, 'merchant@example.dk')
    await ledger.record({
      attribution: accountAttribution(accountId),
      vendor: 'anthropic',
      callType: 'persona',
      usdCost: 0.02,
      cacheHit: false,
      outcome: 'succeeded',
    })

    const error = await harness.pool
      .query('UPDATE spend_events SET usd_cost = 0')
      .then(() => undefined)
      .catch((e: unknown) => e)
    expect(pgErrorCode(error)).toBe(RESTRICT_VIOLATION)
  })

  it('survives an account being deleted — a vendor invoice line is not customer data (§14.6)', async () => {
    const accountId = await insertAccount(harness.pool, 'merchant@example.dk')
    await ledger.record({
      attribution: accountAttribution(accountId, 'example.dk'),
      vendor: 'dataforseo',
      callType: 'serp',
      usdCost: 0.05,
      cacheHit: false,
      outcome: 'succeeded',
    })

    await harness.pool.query('DELETE FROM accounts WHERE id = $1', [accountId])

    const all = await rows()
    expect(all).toHaveLength(1)
    expect(all[0].usd_cost).toBeCloseTo(0.05, 8)
  })
})
