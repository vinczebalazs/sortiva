import { describe, expect, it } from 'vitest'
import { createLogger } from '../observability/logger'
import { accountAttribution, previewAttribution } from './analytics'
import {
  InMemoryCostLedger,
  UnrecordedSpend,
  recordSpend,
  spendAttribution,
  spendEventViolation,
  type SpendEvent,
} from './spend'

/**
 * What a spend row may contain, and what happens when writing one fails.
 *
 * The spend ledger is the counter the kill switches read, and these tests are
 * about the counter's own rules: which of the two attribution columns is set,
 * that a cost is never negative, that free work is recorded as free, and that a
 * ledger outage is logged loudly rather than turned into a failed job. The
 * wrappers' own suites cover that every paid call path writes a row.
 *
 * What these do **not** cover, though this comment used to say they did: the
 * rule that the kill switches read our database and never the analytics
 * vendor. That one is checked in
 * `packages/providers/src/posthog/control-plane.test.ts`.
 */

const ROW: SpendEvent = {
  attribution: accountAttribution('acc-1', 'example.com'),
  vendor: 'anthropic',
  callType: 'distill',
  usdCost: 0.0031,
  cacheHit: false,
  outcome: 'succeeded',
}

describe('spendAttribution', () => {
  it('files account spend under the account and preview spend under the target domain', () => {
    expect(spendAttribution(accountAttribution('acc-1', 'example.com'))).toEqual({
      accountId: 'acc-1',
      previewTarget: null,
    })
    // Ten strangers previewing nike.com is not Nike-the-account
    // costing us money". Never both, which is what the table's check enforces.
    expect(spendAttribution(previewAttribution('nike.com'))).toEqual({
      accountId: null,
      previewTarget: 'nike.com',
    })
  })
})

describe('spendEventViolation', () => {
  it('mirrors the table: no negative cost, and a replay is free', () => {
    expect(spendEventViolation(ROW)).toBeUndefined()
    expect(spendEventViolation({ ...ROW, usdCost: -1 })).toMatch(/usd_cost/)
    expect(spendEventViolation({ ...ROW, cacheHit: true })).toMatch(/cache hit/)
    expect(spendEventViolation({ ...ROW, cacheHit: true, usdCost: 0 })).toBeUndefined()
  })
})

describe('InMemoryCostLedger', () => {
  it('rejects a row Postgres would reject, so a test cannot pass on a bad one', async () => {
    const ledger = new InMemoryCostLedger()
    await expect(ledger.record({ ...ROW, cacheHit: true })).rejects.toThrow(
      /spend_events would reject/,
    )
    expect(ledger.rows).toHaveLength(0)
  })

  it('sums what the caps would read, and separates failures from successes', async () => {
    const ledger = new InMemoryCostLedger()
    await ledger.record(ROW)
    await ledger.record({ ...ROW, vendor: 'dataforseo', outcome: 'failed', usdCost: 0.05 })
    await ledger.record({ ...ROW, cacheHit: true, usdCost: 0 })

    expect(ledger.totalUsdCost).toBeCloseTo(0.0531, 9)
    expect(ledger.of('dataforseo')).toHaveLength(1)
    expect(ledger.withOutcome('failed')).toHaveLength(1)
  })
})

describe('recordSpend', () => {
  it('logs loudly but does not throw when the ledger is unreachable', async () => {
    const lines: string[] = []
    const ledger = new InMemoryCostLedger()
    ledger.failWith = new Error('connection refused')

    await expect(
      recordSpend(ledger, ROW, createLogger({ sink: (l) => lines.push(l), minLevel: 'debug' })),
    ).resolves.toBeUndefined()

    // An unrecorded cost means the caps are reading low: error, not warn.
    expect(lines).toHaveLength(1)
    const record = JSON.parse(lines[0]!) as Record<string, unknown>
    expect(record.level).toBe('error')
    expect(record.msg).toBe('spend_event_not_recorded')
    expect(record.vendor).toBe('anthropic')
  })
})

describe('UnrecordedSpend', () => {
  it('exists so that "not metered" has to be written down', async () => {
    await expect(new UnrecordedSpend().record(ROW)).resolves.toBeUndefined()
  })
})
