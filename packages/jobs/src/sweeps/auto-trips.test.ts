import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  accountScope,
  appendSpendEvent,
  insertMinimalOpportunity,
  isAccountFlagActive,
  isGlobalFlagActive,
  systemScope,
  tripAccountFlag,
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
  ACCOUNT_INTENT_GAP_PAUSED_FLAG,
  ACCOUNT_OPTIMIZE_PAUSED_FLAG,
  ACCOUNT_PAUSED_FLAG,
  ALL_WORK_PAUSED_FLAG,
  MODEL_CALLS_PER_PAID_ANALYSIS_MAX,
  PUBLISHING_PAUSED_FLAG,
  createLogger,
  silentLogger,
  type AnalyticsEvent,
  type FailureCount,
  type JudgeOutcomeCounter,
  type PosthogCapture,
  type PublishOutcomeCounter,
} from '@sortiva/core'
import { rules } from '@sortiva/rules'
import { evaluateAutoTrips } from './auto-trips'

/**
 * The three brakes that are not about a dollar total, against a real database.
 *
 * The case that matters most is the last one: a trip has to fire with the
 * analytics vendor unreachable. Analytics displays cost and raises alerts; our
 * own code and our own database decide. A brake that stops working when a
 * dashboard is slow is not a brake, and the only way to know it does not is to
 * take the vendor away and watch the switch still go up.
 */

const CAPS = rules().defaults.auto_trips
const BUDGETS = rules().defaults.budgets
const SYSTEM = systemScope('these ceilings are about the whole product')
const NOW = new Date('2026-09-01T12:00:00.000Z')

let harness: TestDb
let db: Db

beforeAll(async () => {
  if (!(await databaseAvailable())) {
    throw new Error('Postgres is not reachable. Run `pnpm db:up` before the test suite.')
  }
  harness = await setupTestDb('auto_trips')
  db = harness.db
}, 60_000)

afterAll(async () => {
  await harness?.close()
})

beforeEach(async () => {
  await truncateAll(harness.pool)
})

function judgeSaw(failures: number, sample: number): JudgeOutcomeCounter {
  return { recentJudgeOutcomes: async (): Promise<FailureCount> => ({ failures, sample, measurable: true }) }
}

function publishingSaw(failures: number, sample: number): PublishOutcomeCounter {
  return { recentPublishOutcomes: async (): Promise<FailureCount> => ({ failures, sample, measurable: true }) }
}

/** Records everything the sweep tried to tell analytics. */
class RecordingCapture implements PosthogCapture {
  readonly events: AnalyticsEvent[] = []
  capture(event: AnalyticsEvent): void {
    this.events.push(event)
  }
  captureAiGeneration(): void {}
  captureSeoRequest(): void {}
  captureException(): void {}
  async flush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

/**
 * The analytics vendor as it behaves in the failure this boundary exists for:
 * every call throws. Not "returns nothing" — a client that silently drops
 * events would be indistinguishable from a healthy one and would prove nothing.
 */
class OfflineCapture implements PosthogCapture {
  calls = 0
  capture(): void {
    this.calls += 1
    throw new Error('PostHog is unreachable: getaddrinfo ENOTFOUND eu.posthog.com')
  }
  captureAiGeneration(): void {
    throw new Error('PostHog is unreachable')
  }
  captureSeoRequest(): void {
    throw new Error('PostHog is unreachable')
  }
  captureException(): void {
    throw new Error('PostHog is unreachable')
  }
  async flush(): Promise<void> {
    throw new Error('PostHog is unreachable')
  }
  async shutdown(): Promise<void> {
    throw new Error('PostHog is unreachable')
  }
}

async function usedCallType(
  accountId: string,
  callType: string,
  times: number,
  occurredAt: Date = NOW,
): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await appendSpendEvent(db, accountScope(accountId), {
      vendor: 'anthropic',
      callType,
      usdCost: 0.01,
      cacheHit: false,
      outcome: 'succeeded',
      occurredAt,
    })
  }
}

/**
 * One finished OPTIMIZE generation, as the product leaves it behind: a stored
 * recommendation hanging off an opportunity, plus the model calls it took.
 *
 * `calls` is what makes this worth planting rather than faking — one generation
 * is one recommendation however many times the model had to be asked, and the
 * whole defect this card fixes was counting the asking.
 */
async function generatedOptimizeRecommendations(
  accountId: string,
  generations: number,
  callsEach = 1,
  at: Date = NOW,
): Promise<void> {
  for (let i = 0; i < generations; i += 1) {
    const opportunity = await insertMinimalOpportunity(
      db,
      accountScope(accountId),
      {
        signalType: 'existing_page_intent_gap',
        entityType: 'url',
        entityRef: `https://shop.example/collections/page-${i}`,
        evidenceJson: [],
        recommendedAction: 'optimize',
        status: 'accepted',
        reasonTemplateKey: 'opportunity.existing_page_intent_gap',
        reasonParams: {},
        limitedIntelligence: false,
        rulesVersion: rules().rulesVersion,
      },
      at,
    )
    await harness.pool.query(
      `INSERT INTO optimize_recommendations
         (opportunity_id, page_url, recommendation_json, prompt_version, model_id, rules_version, generated_at, state)
       VALUES ($1, $2, '{}'::jsonb, 'optimize-reco.v1', 'claude-sonnet-5', $3, $4, 'valid')`,
      [opportunity.id, `https://shop.example/collections/page-${i}`, rules().rulesVersion, at],
    )
    await usedCallType(accountId, 'optimize_reco', callsEach, at)
  }
}

const sweep = (deps: Parameters<typeof evaluateAutoTrips>[1] = {}) =>
  evaluateAutoTrips(db, { now: () => NOW, log: silentLogger, ...deps })

describe('the quality judge rejecting most of what it sees', () => {
  it('stops all generation, says how bad it got, and pages', async () => {
    const rejected = Math.ceil(CAPS.judge_fail_rate.trailing_drafts * 0.7)
    const paged: string[] = []
    const analytics = new RecordingCapture()

    const report = await sweep({
      judge: judgeSaw(rejected, CAPS.judge_fail_rate.trailing_drafts),
      analytics,
      log: createLogger({ sink: (line) => paged.push(line), minLevel: 'error' }),
    })

    expect(report.trips).toHaveLength(1)
    expect(report.trips[0]?.flag).toBe(ALL_WORK_PAUSED_FLAG)
    expect(report.trips[0]?.reason).toContain('70%')
    expect(await isGlobalFlagActive(db, SYSTEM, ALL_WORK_PAUSED_FLAG)).toBe(true)

    // Paging is two things and both have to happen: a line at error level,
    // which is what the crash reporter and the log alert see, and the event the
    // analytics alert watches. Neither of them causes the pause.
    expect(paged.filter((line) => line.includes('"msg":"kill_switch_tripped"'))).toHaveLength(1)
    expect(paged[0]).toContain('"level":"error"')
    expect(analytics.events.map((e) => e.event)).toEqual(['kill_switch_tripped'])
  })

  it('leaves a rate under the ceiling alone', async () => {
    const rejected = Math.floor(CAPS.judge_fail_rate.trailing_drafts * 0.5)
    const report = await sweep({ judge: judgeSaw(rejected, CAPS.judge_fail_rate.trailing_drafts) })

    expect(report.trips).toEqual([])
    expect(await isGlobalFlagActive(db, SYSTEM, ALL_WORK_PAUSED_FLAG)).toBe(false)
  })

  it('will not trip on a sample too small to mean anything', async () => {
    // Two rejections out of two is 100% and says nothing at all. Tripping on it
    // would pause the product every quiet morning.
    const report = await sweep({ judge: judgeSaw(2, 2) })

    expect(report.trips).toEqual([])
    expect(await isGlobalFlagActive(db, SYSTEM, ALL_WORK_PAUSED_FLAG)).toBe(false)
  })

  it('raises one switch however often the sweep runs while it is still bad', async () => {
    const judge = judgeSaw(CAPS.judge_fail_rate.trailing_drafts, CAPS.judge_fail_rate.trailing_drafts)
    await sweep({ judge })
    const second = await sweep({ judge })

    expect(second.trips[0]?.raised).toBe(false)
    const { rows } = await harness.pool.query('SELECT count(*)::int AS n FROM ops_flags')
    expect(rows[0].n).toBe(1)
  })

  it('says it cannot see, rather than reporting a healthy zero', async () => {
    // Nothing records a draft's gate decision yet. "No failures" and "nobody is
    // writing it down" have to be different answers, or a brake that cannot see
    // looks exactly like a brake with nothing to do.
    const report = await sweep()

    expect(report.unmeasurable).toContain('judge_fail_rate')
    expect(report.trips).toEqual([])
  })
})

describe('publishing failing at the far end', () => {
  it('pauses publishing and leaves generation running', async () => {
    const report = await sweep({ publishing: publishingSaw(6, 10) })

    expect(report.trips.map((t) => t.flag)).toEqual([PUBLISHING_PAUSED_FLAG])
    expect(await isGlobalFlagActive(db, SYSTEM, PUBLISHING_PAUSED_FLAG)).toBe(true)
    // Degrade to pause, never to lower quality — and never wider than needed.
    expect(await isGlobalFlagActive(db, SYSTEM, ALL_WORK_PAUSED_FLAG)).toBe(false)
  })

  it('ignores one failure in a quiet hour', async () => {
    const report = await sweep({ publishing: publishingSaw(1, 2) })

    expect(report.trips).toEqual([])
  })

  it('says it cannot see publish outcomes either', async () => {
    expect((await sweep()).unmeasurable).toContain('publish_error_rate')
  })
})

describe('one store\'s daily allowance of a paid analysis', () => {
  const OPTIMIZE_ALLOWANCE = BUDGETS.optimize.generations_per_account_per_day
  const INTENT_GAP_ALLOWANCE = BUDGETS.intent_gap.analyses_per_account_per_day

  it('leaves a store that used every one of its recommendations alone', async () => {
    // The defect this card exists for. Two recommendations is what the merchant
    // is entitled to, and having them is not a reason to switch the feature off.
    const account = await insertAccount(harness.pool, 'full@example.com')
    await generatedOptimizeRecommendations(account, OPTIMIZE_ALLOWANCE)

    const report = await sweep()

    expect(report.trips).toEqual([])
    expect(await isAccountFlagActive(db, accountScope(account), ACCOUNT_OPTIMIZE_PAUSED_FLAG)).toBe(
      false,
    )
  })

  it('leaves a recommendation that needed a second attempt alone', async () => {
    // One recommendation, four model calls: the writer's answer, a re-ask when
    // it came back unreadable, and the same pair again when our own checks
    // rejected the first attempt. One generation, and the store has one left.
    const account = await insertAccount(harness.pool, 'retried@example.com')
    await generatedOptimizeRecommendations(account, 1, 4)

    expect((await sweep()).trips).toEqual([])
  })

  it('stops that call type, and nothing else, when a store goes past the allowance', async () => {
    const account = await insertAccount(harness.pool, 'over@example.com')
    await generatedOptimizeRecommendations(account, OPTIMIZE_ALLOWANCE + 1)

    const report = await sweep()

    expect(report.trips.map((t) => t.flag)).toEqual([ACCOUNT_OPTIMIZE_PAUSED_FLAG])
    expect(report.trips[0]?.accountId).toBe(account)
    expect(await isAccountFlagActive(db, accountScope(account), ACCOUNT_OPTIMIZE_PAUSED_FLAG)).toBe(
      true,
    )
    // The daily article is untouched; so is the other paid call type.
    expect(await isAccountFlagActive(db, accountScope(account), ACCOUNT_INTENT_GAP_PAUSED_FLAG)).toBe(
      false,
    )
    expect(await isGlobalFlagActive(db, SYSTEM, ALL_WORK_PAUSED_FLAG)).toBe(false)
  })

  it('tells the operator how many generations there really were', async () => {
    // Three recommendations that took two model calls each. The incident has to
    // say three; it used to say six.
    const account = await insertAccount(harness.pool, 'counted@example.com')
    await generatedOptimizeRecommendations(account, OPTIMIZE_ALLOWANCE + 1, 2)

    const report = await sweep()

    expect(report.trips[0]?.reason).toContain(`${OPTIMIZE_ALLOWANCE + 1} OPTIMIZE generations`)
    expect(report.trips[0]?.reason).not.toContain(`${(OPTIMIZE_ALLOWANCE + 1) * 2}`)
  })

  it('leaves a store that used every one of its intent-gap analyses alone', async () => {
    const account = await insertAccount(harness.pool, 'gap-full@example.com')
    await usedCallType(account, 'intent_gap', INTENT_GAP_ALLOWANCE)

    expect((await sweep()).trips).toEqual([])
  })

  it('leaves intent-gap analyses that needed a second ask alone', async () => {
    // Every analysis the store is allowed, each of which had to be asked twice.
    const account = await insertAccount(harness.pool, 'gap-retried@example.com')
    await usedCallType(
      account,
      'intent_gap',
      INTENT_GAP_ALLOWANCE * MODEL_CALLS_PER_PAID_ANALYSIS_MAX,
    )

    expect((await sweep()).trips).toEqual([])
  })

  it('stops intent-gap analysis once even the re-asks cannot explain the calls', async () => {
    const account = await insertAccount(harness.pool, 'gap-over@example.com')
    await usedCallType(
      account,
      'intent_gap',
      INTENT_GAP_ALLOWANCE * MODEL_CALLS_PER_PAID_ANALYSIS_MAX + 1,
    )

    const report = await sweep()

    expect(report.trips.map((t) => t.flag)).toEqual([ACCOUNT_INTENT_GAP_PAUSED_FLAG])
    // The incident says what it counted and how that relates to the allowance,
    // rather than reporting model calls as though they were analyses.
    expect(report.trips[0]?.reason).toContain('paid model calls for intent-gap analyses')
    expect(report.trips[0]?.reason).toContain(`allowance is ${INTENT_GAP_ALLOWANCE} analyses a day`)
  })

  it('does not spend a store\'s allowance on work served from cache', async () => {
    const account = await insertAccount(harness.pool, 'cached@example.com')
    // Enough replays to blow through the allowance twice over. Each cost
    // nothing and bought nothing new, so none of them should count against it.
    for (let i = 0; i < INTENT_GAP_ALLOWANCE * 4; i += 1) {
      await appendSpendEvent(db, accountScope(account), {
        vendor: 'anthropic',
        callType: 'intent_gap',
        usdCost: 0,
        cacheHit: true,
        outcome: 'succeeded',
        occurredAt: NOW,
      })
    }

    expect((await sweep()).trips).toEqual([])
  })

  it('does not count one store\'s work against another', async () => {
    const loud = await insertAccount(harness.pool, 'loud@example.com')
    const quiet = await insertAccount(harness.pool, 'quiet@example.com')
    await generatedOptimizeRecommendations(loud, OPTIMIZE_ALLOWANCE + 1)
    await generatedOptimizeRecommendations(quiet, 1)

    const report = await sweep()

    expect(report.trips).toHaveLength(1)
    expect(report.trips[0]?.accountId).toBe(loud)
  })
})

describe('a daily allowance comes back the next day, with nobody asked', () => {
  const OPTIMIZE_ALLOWANCE = BUDGETS.optimize.generations_per_account_per_day
  const TOMORROW = new Date('2026-09-02T00:04:00.000Z')

  it('lowers its own switch once the day it was about has passed', async () => {
    const account = await insertAccount(harness.pool, 'tomorrow@example.com')
    await generatedOptimizeRecommendations(account, OPTIMIZE_ALLOWANCE + 1)

    await sweep()
    expect(await isAccountFlagActive(db, accountScope(account), ACCOUNT_OPTIMIZE_PAUSED_FLAG)).toBe(
      true,
    )

    // Four minutes past midnight, on the sweep's ordinary five-minute clock.
    // Nobody has done anything; yesterday's count simply is not today's.
    const next = await sweep({ now: () => TOMORROW })

    expect(next.cleared).toEqual([
      { flag: ACCOUNT_OPTIMIZE_PAUSED_FLAG, accountId: account },
    ])
    expect(await isAccountFlagActive(db, accountScope(account), ACCOUNT_OPTIMIZE_PAUSED_FLAG)).toBe(
      false,
    )
  })

  it('leaves the switch up while the store is still over', async () => {
    const account = await insertAccount(harness.pool, 'still-over@example.com')
    await generatedOptimizeRecommendations(account, OPTIMIZE_ALLOWANCE + 1)

    await sweep()
    const second = await sweep()

    expect(second.cleared).toEqual([])
    expect(await isAccountFlagActive(db, accountScope(account), ACCOUNT_OPTIMIZE_PAUSED_FLAG)).toBe(
      true,
    )
  })

  it('never lowers a switch a person raised', async () => {
    // An operator paused this store's recommendations for a reason the sweep
    // knows nothing about. It is not the sweep's to decide that reason expired.
    const account = await insertAccount(harness.pool, 'operator@example.com')
    await tripAccountFlag(db, accountScope(account), {
      flag: ACCOUNT_OPTIMIZE_PAUSED_FLAG,
      actor: 'dana',
      reason: 'Investigating a complaint about this store\'s suggestions.',
      trippedBy: 'manual',
    })

    const report = await sweep({ now: () => TOMORROW })

    expect(report.cleared).toEqual([])
    expect(await isAccountFlagActive(db, accountScope(account), ACCOUNT_OPTIMIZE_PAUSED_FLAG)).toBe(
      true,
    )
  })

  it('never lowers a switch about anything but a daily allowance', async () => {
    // The store's whole pipeline was stopped because its spending ran away.
    // That is an incident, and an incident waits for a person.
    const account = await insertAccount(harness.pool, 'runaway@example.com')
    await tripAccountFlag(db, accountScope(account), {
      flag: ACCOUNT_PAUSED_FLAG,
      actor: 'spend_cap_sweep',
      reason: 'Spent far more than this store normally does.',
      trippedBy: 'auto',
    })

    const report = await sweep({ now: () => TOMORROW })

    expect(report.cleared).toEqual([])
    expect(await isAccountFlagActive(db, accountScope(account), ACCOUNT_PAUSED_FLAG)).toBe(true)
  })
})

describe('analytics is told, never asked', () => {
  it('announces a trip when the vendor is reachable', async () => {
    const analytics = new RecordingCapture()
    await sweep({
      judge: judgeSaw(CAPS.judge_fail_rate.trailing_drafts, CAPS.judge_fail_rate.trailing_drafts),
      analytics,
    })

    expect(analytics.events.map((e) => e.event)).toEqual(['kill_switch_tripped'])
    expect(analytics.events[0]?.properties).toMatchObject({
      flag: ALL_WORK_PAUSED_FLAG,
      tripped_by: 'auto',
    })
    // Ids and aggregates only. No reason text, no draft, no prompt.
    expect(JSON.stringify(analytics.events[0]?.properties)).not.toContain('drafts')
  })

  it('fires the trip with the analytics vendor offline', async () => {
    // The control-plane boundary, proved rather than asserted: every call into
    // the vendor throws, and the switch still goes up in our own database.
    const analytics = new OfflineCapture()
    const account = await insertAccount(harness.pool, 'offline@example.com')
    await usedCallType(
      account,
      'intent_gap',
      BUDGETS.intent_gap.analyses_per_account_per_day * MODEL_CALLS_PER_PAID_ANALYSIS_MAX + 1,
    )

    const report = await sweep({
      judge: judgeSaw(CAPS.judge_fail_rate.trailing_drafts, CAPS.judge_fail_rate.trailing_drafts),
      publishing: publishingSaw(9, 10),
      analytics,
    })

    // It really did try to reach the vendor, and the vendor really did fail.
    expect(analytics.calls).toBeGreaterThan(0)

    expect(report.trips.map((t) => t.flag).sort()).toEqual(
      [ACCOUNT_INTENT_GAP_PAUSED_FLAG, ALL_WORK_PAUSED_FLAG, PUBLISHING_PAUSED_FLAG].sort(),
    )
    expect(await isGlobalFlagActive(db, SYSTEM, ALL_WORK_PAUSED_FLAG)).toBe(true)
    expect(await isGlobalFlagActive(db, SYSTEM, PUBLISHING_PAUSED_FLAG)).toBe(true)
    expect(await isAccountFlagActive(db, accountScope(account), ACCOUNT_INTENT_GAP_PAUSED_FLAG)).toBe(
      true,
    )
  })
})

describe('an automatic trip never lowers itself', () => {
  it('leaves the switch up once the condition has passed', async () => {
    const bad = judgeSaw(CAPS.judge_fail_rate.trailing_drafts, CAPS.judge_fail_rate.trailing_drafts)
    await sweep({ judge: bad })
    expect(await isGlobalFlagActive(db, SYSTEM, ALL_WORK_PAUSED_FLAG)).toBe(true)

    // Whatever was wrong has stopped. A person still has to decide it is over.
    await sweep({ judge: judgeSaw(0, CAPS.judge_fail_rate.trailing_drafts) })

    expect(await isGlobalFlagActive(db, SYSTEM, ALL_WORK_PAUSED_FLAG)).toBe(true)
  })
})
