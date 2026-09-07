import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { makeWorkerUtils, type WorkerUtils } from 'graphile-worker'
import {
  MODEL_CALLS_PER_PAID_ANALYSIS_MAX,
  silentLogger,
  type CoverageAnalysisOutput,
  type LlmClient,
  type LlmRequest,
  type LlmResult,
} from '@sortiva/core'
import {
  accountScope,
  appendSpendEvent,
  schema,
  upsertGscQueryDaily,
  upsertPersona,
  upsertQueryClusters,
  upsertStorePages,
  type Db,
} from '@sortiva/db'
import {
  TEST_DATABASE_URL,
  databaseAvailable,
  insertAccount,
  setupTestDb,
  truncateAll,
  type TestDb,
} from '@sortiva/db/testing'
import { MockPageFetcher, MockSeoDataProvider } from '@sortiva/providers'
import { rules } from '@sortiva/rules'
import { installKillSwitchReader, mayCallTypeRun, resetKillSwitchReader } from '../runtime/gate'
import { analyseIntentGap } from './analyse'
import { deriveIdempotencyKey, inputVersion } from '../runtime/idempotency'
import { lookupCompletedWork } from '../runtime/ledger'
import { clearTasks, taskList } from '../runtime/tasks'
import { evaluateAutoTrips } from '../sweeps/auto-trips'
import { INTENT_GAP_PASS_STEP, runIntentGapPassForAccount } from './intent-gap-pass'
import {
  INTENT_GAP_ACCOUNT_TASK,
  INTENT_GAP_SWEEP_TASK,
  registerIntentGapTasks,
  resetIntentGapTaskRegistration,
  sweepIntentGapPasses,
  type IntentGapTaskDeps,
} from './intent-gap-tasks'

/**
 * The scheduled pass, against a real database.
 *
 * What these cases are actually about is money. The comparison this pass runs
 * is the most expensive thing the product does without a merchant asking for
 * it — a bought results page, five page reads and a model call, per page — so
 * three of the five cases below are about *not* spending: not when the store's
 * allowance is gone, not when the answer is already on hand, and not a second
 * time for work a killed pass already paid for.
 */

const available = await databaseAvailable()

const BUDGETS = rules().defaults.budgets

/**
 * Enough paid model calls to put this store past its intent-gap allowance for the
 * day, which is what raises the flag these cases are about. More rows than
 * analyses because one analysis costs a second call when the first answer comes
 * back unreadable, and the brake leaves room for that.
 */
const PAST_THE_ALLOWANCE =
  BUDGETS.intent_gap.analyses_per_account_per_day * MODEL_CALLS_PER_PAID_ANALYSIS_MAX + 1
/** A Sunday, which is the day this pass is for. */
const NOW = new Date('2026-09-06T09:00:00.000Z')
const NEXT_DAY = new Date('2026-09-07T09:00:00.000Z')
const PROMPT = { version: 'intent-gap.v1', text: 'compare the pages' }

const PAGES = [
  { url: 'https://shop.example/collections/hiking-boots', handle: 'hiking-boots', query: 'waterproof hiking boots' },
  { url: 'https://shop.example/collections/trail-shoes', handle: 'trail-shoes', query: 'trail running shoes' },
] as const

const RIVALS = [1, 2, 3, 4, 5].map((n) => ({
  position: n,
  url: `https://rival${n}.example/boots`,
  domain: `rival${n}.example`,
  title: `Best boots ${n}`,
}))

/** Four subtopics on enough of the pages above us to clear the consensus floor, and one that is not. */
function coverageAnswer(): CoverageAnalysisOutput {
  const covering = (count: number, heading: string) =>
    RIVALS.slice(0, count).map((r) => ({ url: r.url, heading }))
  return {
    subtopics: [
      { name: 'waterproofing', presentOnOurPage: false, ourEvidence: null, competitors: covering(5, 'Waterproofing') },
      { name: 'terrain', presentOnOurPage: false, ourEvidence: null, competitors: covering(4, 'Terrain') },
      { name: 'fit', presentOnOurPage: false, ourEvidence: null, competitors: covering(3, 'Fit') },
      { name: 'sizing', presentOnOurPage: false, ourEvidence: null, competitors: covering(3, 'Sizing') },
    ],
  }
}

/**
 * Counts what a comparison actually cost, so "paid nothing" can be asserted as
 * zero rather than merely inferred. `failAfter` makes the process die at a
 * chosen point mid-pass, which is what the resume case needs.
 */
class CountingLlmClient implements LlmClient {
  readonly requests: LlmRequest[] = []
  constructor(private readonly failAfter = Number.POSITIVE_INFINITY) {}
  async complete<T>(request: LlmRequest): Promise<LlmResult<T>> {
    this.requests.push(request)
    if (this.requests.length > this.failAfter) throw new Error('the worker died mid-pass')
    return {
      output: coverageAnswer() as T,
      text: JSON.stringify(coverageAnswer()),
      modelId: 'claude-sonnet-5',
      promptVersion: request.promptVersion,
      cacheHit: false,
      usage: { inputTokens: 900, outputTokens: 600, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      usdCost: 0.008,
      latencyMs: 12,
      attempts: 1,
    }
  }
}

let harness: TestDb
let db: Db
let utils: WorkerUtils
let accountId: string

beforeAll(async () => {
  if (!available) {
    throw new Error('Postgres is not reachable. Run `pnpm db:up` before the test suite.')
  }
  harness = await setupTestDb('intent_gap_pass')
  db = harness.db
  // The queue's own tables are installed by the worker, not by our migrations.
  const url = new URL(TEST_DATABASE_URL)
  url.pathname = `/${harness.databaseName}`
  utils = await makeWorkerUtils({ connectionString: url.toString() })
}, 60_000)

afterAll(async () => {
  await utils?.release()
  await harness?.close()
})

beforeEach(async () => {
  await truncateAll(harness.pool)
  await harness.pool.query('TRUNCATE graphile_worker._private_jobs CASCADE')
  clearTasks()
  resetIntentGapTaskRegistration()
  installKillSwitchReader(() => db)

  accountId = await insertAccount(harness.pool, 'gap@example.com')
  await seedStore(accountId, 'UTC')
})

afterEach(() => {
  clearTasks()
  resetIntentGapTaskRegistration()
  resetKillSwitchReader()
})

/** A store that would shortlist both of its pages: each ranks at #11 for its own search, with plenty of impressions. */
async function seedStore(id: string, timezone: string): Promise<void> {
  const scope = accountScope(id)
  await db.insert(schema.accountSettings).values({ accountId: id, timezone }).onConflictDoNothing()
  await upsertPersona(db, scope, {
    description: 'Outdoor gear for weekend walkers',
    productCategories: ['boots'],
    language: 'en',
    country: 'GB',
    audience: 'walkers',
    tone: 'plain',
    richnessScore: 0.8,
    promptVersion: 'persona.v1',
    modelId: 'claude-sonnet-5',
  })
  await upsertStorePages(
    db,
    scope,
    PAGES.map((page, index) => ({
      url: page.url,
      pageType: 'collection' as const,
      handle: page.handle,
      shopifyId: `gid://shopify/Collection/${index + 1}`,
      title: page.handle,
      seoTitle: page.handle,
      seoDescription: `Our ${page.handle}`,
      headings: ['Our range'],
      bodyHtml: `<p>Browse our ${page.handle}. Free delivery over £50.</p>`,
      outboundInternalLinks: [],
      familyIds: [],
      checksum: `checksum-${page.handle}-v1`,
    })),
  )
  await upsertQueryClusters(
    db,
    scope,
    PAGES.map((page) => ({ headQuery: page.query, memberQueries: [page.query] })),
  )
  // Enough days that every window these cases look through is covered, whatever
  // Search Console's reporting lag is set to.
  const rows = []
  for (let back = 0; back < 90; back += 1) {
    const day = new Date(NOW)
    day.setUTCDate(day.getUTCDate() - back)
    for (const page of PAGES) {
      rows.push({
        date: day.toISOString().slice(0, 10),
        page: page.url,
        query: page.query,
        device: 'desktop',
        country: 'gbr',
        clicks: 3,
        impressions: 200,
        position: 11,
      })
    }
  }
  await upsertGscQueryDaily(db, scope, rows)
}

/** A page seeded on top of the two every case starts with, to crowd the shortlist. */
interface ExtraPage {
  readonly url: string
  readonly handle: string
  readonly query: string
}

function fixtures(failAfter?: number, extra: readonly ExtraPage[] = []) {
  const seo = new MockSeoDataProvider({
    serp: Object.fromEntries(
      [...PAGES, ...extra].map((page) => [page.query, RIVALS]),
    ),
  })
  const pageFetcher = new MockPageFetcher()
  for (const rival of RIVALS) {
    pageFetcher.on(rival.url, '<h2>Waterproofing</h2><p>Gore-Tex keeps water out.</p>')
  }
  const llm = new CountingLlmClient(failAfter)
  return { seo, pageFetcher, llm }
}

function passDeps(f: ReturnType<typeof fixtures>, now: Date = NOW) {
  return { db, pool: harness.pool, ...f, prompt: PROMPT, now: () => now, logger: silentLogger }
}

function taskDeps(f: ReturnType<typeof fixtures>, now: Date = NOW): IntentGapTaskDeps {
  return {
    getDb: () => db,
    getPool: () => harness.pool,
    ...f,
    prompt: PROMPT,
    now: () => now,
    logger: silentLogger,
  }
}

/** Puts the store past its allowance and lets the real sweep raise the flag. */
async function spendTheAllowance(): Promise<void> {
  for (let i = 0; i < PAST_THE_ALLOWANCE; i += 1) {
    await appendSpendEvent(db, accountScope(accountId), {
      vendor: 'anthropic',
      callType: 'intent_gap',
      usdCost: 0.01,
      cacheHit: false,
      outcome: 'succeeded',
      occurredAt: NOW,
    })
  }
  await evaluateAutoTrips(db, { now: () => NOW, log: silentLogger })
}

describe.skipIf(!available)('the task the worker actually runs', () => {
  it('is the real pass: running the registered handler buys the comparisons and records the day', async () => {
    const f = fixtures()
    registerIntentGapTasks(taskDeps(f))

    const handler = taskList()[INTENT_GAP_ACCOUNT_TASK]
    expect(handler).toBeDefined()
    expect(taskList()[INTENT_GAP_SWEEP_TASK]).toBeDefined()

    await handler!({ accountId, date: '2026-09-06' }, {} as never)

    // Nothing about this is a stand-in: two results pages were bought, ten
    // competitor pages read and two comparisons made, for the two pages this
    // store has sitting where an edit could move them.
    expect(f.seo.billableCalls).toBe(2)
    expect(f.pageFetcher.callCount).toBe(10)
    expect(f.llm.requests).toHaveLength(2)
    expect(f.llm.requests[0]!.callType).toBe('intent_gap')

    const key = deriveIdempotencyKey(
      accountId,
      INTENT_GAP_PASS_STEP,
      inputVersion({ date: '2026-09-06' }),
    )
    expect(await lookupCompletedWork(db, key)).toEqual({
      outputRef: { shortlisted: 2, analysed: 2, detected: 2 },
    })
  })

  it('queues one job for a store whose own clock says Sunday, and none for the same store again that day', async () => {
    const deps = taskDeps(fixtures())

    const first = await sweepIntentGapPasses(deps)
    const second = await sweepIntentGapPasses(deps)

    // No Search Console connection yet, so there is nothing to shortlist on.
    expect(first).toEqual({ considered: 0, queued: 0 })

    await db.insert(schema.gscConns).values({
      accountId,
      property: 'sc-domain:shop.example',
      tokens: 'ciphertext',
    })
    const third = await sweepIntentGapPasses(deps)
    const fourth = await sweepIntentGapPasses(deps)

    expect(second).toEqual({ considered: 0, queued: 0 })
    expect(third).toEqual({ considered: 1, queued: 1 })
    expect(fourth).toEqual({ considered: 1, queued: 1 })
    expect(await queuedKeys()).toEqual([`${INTENT_GAP_ACCOUNT_TASK}:${accountId}:2026-09-06`])

    // Monday is the scan's day, not this pass's.
    const monday = await sweepIntentGapPasses(taskDeps(fixtures(), NEXT_DAY))
    expect(monday).toEqual({ considered: 1, queued: 0 })
  })
})

describe.skipIf(!available)('a store this call type has been paused for', () => {
  it('buys nothing, does not fail, and does not record the day as finished', async () => {
    await spendTheAllowance()
    const f = fixtures()

    const outcome = await runIntentGapPassForAccount(passDeps(f), accountId)

    expect(outcome.status).toBe('paused_part_way')
    expect(f.seo.billableCalls).toBe(0)
    expect(f.pageFetcher.callCount).toBe(0)
    expect(f.llm.requests).toHaveLength(0)

    // Left unfinished on purpose: recording the day as done would mean these
    // pages are never reached even after the allowance resets.
    const key = deriveIdempotencyKey(
      accountId,
      INTENT_GAP_PASS_STEP,
      inputVersion({ date: '2026-09-06' }),
    )
    expect(await lookupCompletedWork(db, key)).toBeUndefined()
  })
})

describe.skipIf(!available)('a pass over a shortlist nothing has changed about', () => {
  it('answers from the ledger on the same day, without re-walking anything', async () => {
    const f = fixtures()
    await runIntentGapPassForAccount(passDeps(f), accountId)

    const again = await runIntentGapPassForAccount(passDeps(f), accountId)

    expect(again).toEqual({ status: 'already_done', date: '2026-09-06', analysed: 2 })
    expect(f.llm.requests).toHaveLength(2)
  })

  it('re-walks it the next day and still makes no second model call', async () => {
    const f = fixtures()
    await runIntentGapPassForAccount(passDeps(f), accountId)
    const billableAfterFirst = f.seo.billableCalls
    const fetchesAfterFirst = f.pageFetcher.callCount

    const later = await runIntentGapPassForAccount(passDeps(f, NEXT_DAY), accountId)

    expect(later).toEqual({ status: 'completed', date: '2026-09-07', shortlisted: 2, analysed: 2, detected: 2 })
    // Every page compared again, and not one of them paid for again.
    expect(f.llm.requests).toHaveLength(2)
    expect(f.seo.billableCalls).toBe(billableAfterFirst)
    expect(f.pageFetcher.callCount).toBe(fetchesAfterFirst)
  })
})

describe.skipIf(!available)('a pass whose worker dies half-way through', () => {
  it('resumes without paying for the page it already compared', async () => {
    const killed = fixtures(1)

    await expect(runIntentGapPassForAccount(passDeps(killed), accountId)).rejects.toThrow(
      'the worker died mid-pass',
    )
    // One comparison made and stored, one attempt that died with the process.
    expect(killed.llm.requests).toHaveLength(2)
    const key = deriveIdempotencyKey(
      accountId,
      INTENT_GAP_PASS_STEP,
      inputVersion({ date: '2026-09-06' }),
    )
    expect(await lookupCompletedWork(db, key)).toBeUndefined()

    const resumed = fixtures()
    const outcome = await runIntentGapPassForAccount(passDeps(resumed), accountId)

    expect(outcome).toEqual({ status: 'completed', date: '2026-09-06', shortlisted: 2, analysed: 2, detected: 2 })
    // Only the page that never got an answer is paid for: one model call, five
    // page reads, and no results page bought at all — both were already held.
    expect(resumed.llm.requests).toHaveLength(1)
    expect(resumed.pageFetcher.callCount).toBe(5)
    expect(resumed.seo.billableCalls).toBe(0)
  })
})

describe.skipIf(!available)('a pass on a store with more candidates than it may pay to compare', () => {
  const SHORTLIST_MAX = BUDGETS.intent_gap.scheduled_shortlist_max
  const ALLOWANCE = BUDGETS.intent_gap.analyses_per_account_per_day
  const GENERATIONS_A_DAY = BUDGETS.optimize.generations_per_account_per_day

  it('stops short of the store\'s whole daily allowance', async () => {
    const extra = await seedCrowdedStore()
    const f = fixtures(Number.POSITIVE_INFINITY, extra)

    const outcome = await runIntentGapPassForAccount(passDeps(f), accountId)

    expect(outcome.status).toBe('completed')
    expect(SHORTLIST_MAX).toBeLessThan(ALLOWANCE)
    // Asserted on what was bought, not on what the pass says it did.
    expect(f.seo.billableCalls).toBe(SHORTLIST_MAX)
    expect(f.llm.requests).toHaveLength(SHORTLIST_MAX)
  })

  /**
   * The case the shrunk shortlist exists for, end to end and with nothing
   * unusual in it: the scheduled pass runs in full on Sunday morning, and the
   * merchant then presses "improve this page" as many times as their allowance
   * permits. Both spend from the same daily allowance and neither knows the
   * other ran, so the only thing that keeps the merchant's click from being
   * refused is the pass having left room for it.
   */
  it('leaves the merchant every generation their allowance permits', async () => {
    const extra = await seedCrowdedStore()
    const f = fixtures(Number.POSITIVE_INFINITY, extra)

    const outcome = await runIntentGapPassForAccount(passDeps(f), accountId)
    expect(outcome.status).toBe('completed')
    await recordComparisonsBilled(outcome.analysed)

    for (let generation = 0; generation < GENERATIONS_A_DAY; generation += 1) {
      // The nightly brake reads the ledger; run it before every click, as the
      // real one would have between a background pass and a merchant's morning.
      await evaluateAutoTrips(db, { now: () => NOW, log: silentLogger })
      expect(await mayCallTypeRun(db, accountId, 'intent_gap', silentLogger)).toEqual({
        allowed: true,
      })

      const page = extra[generation]!
      const pressed = await analyseIntentGap(
        { db, ...f, prompt: PROMPT, now: () => NOW, logger: silentLogger },
        {
          accountId,
          page: {
            url: page.url,
            title: page.handle,
            headings: ['Our range'],
            excerpt: `Browse our ${page.handle}.`,
            checksum: `checksum-${page.handle}-v1`,
          },
          query: page.query,
          locale: { language: 'en', country: 'GB' },
        },
      )
      expect(pressed.status).toBe('analysed')
      await recordComparisonsBilled(1)
    }

    await evaluateAutoTrips(db, { now: () => NOW, log: silentLogger })
    expect(await mayCallTypeRun(db, accountId, 'intent_gap', silentLogger)).toEqual({ allowed: true })
  })

  /**
   * The same arithmetic against the ceiling this card removed. Without it the
   * assertions above would pass whatever the shortlist did, because they would
   * be testing a brake that never fires.
   */
  it('would have refused that merchant if the pass had shortlisted the whole allowance', async () => {
    await recordComparisonsBilled(ALLOWANCE + GENERATIONS_A_DAY)
    await evaluateAutoTrips(db, { now: () => NOW, log: silentLogger })

    const decision = await mayCallTypeRun(db, accountId, 'intent_gap', silentLogger)
    expect(decision.allowed).toBe(false)
  })
})

/**
 * What one paid comparison costs the store in the ledger the brake reads, at
 * the worst the model wrapper's single re-ask allows. Written by hand because
 * these cases run against a mock model client, which bills nobody.
 */
async function recordComparisonsBilled(comparisons: number): Promise<void> {
  for (let call = 0; call < comparisons * MODEL_CALLS_PER_PAID_ANALYSIS_MAX; call += 1) {
    await appendSpendEvent(db, accountScope(accountId), {
      vendor: 'anthropic',
      callType: 'intent_gap',
      usdCost: 0.01,
      cacheHit: false,
      outcome: 'succeeded',
      occurredAt: NOW,
    })
  }
}

/** More pages sitting where an edit could move them than the store could pay to compare in a day. */
async function seedCrowdedStore(): Promise<readonly ExtraPage[]> {
  const extra: ExtraPage[] = []
  for (let n = 0; n < BUDGETS.intent_gap.analyses_per_account_per_day + 4; n += 1) {
    extra.push({
      url: `https://shop.example/collections/range-${n}`,
      handle: `range-${n}`,
      query: `walking gear ${n}`,
    })
  }

  const scope = accountScope(accountId)
  await upsertStorePages(
    db,
    scope,
    extra.map((page, index) => ({
      url: page.url,
      pageType: 'collection' as const,
      handle: page.handle,
      shopifyId: `gid://shopify/Collection/${100 + index}`,
      title: page.handle,
      seoTitle: page.handle,
      seoDescription: `Our ${page.handle}`,
      headings: ['Our range'],
      bodyHtml: `<p>Browse our ${page.handle}. Free delivery over £50.</p>`,
      outboundInternalLinks: [],
      familyIds: [],
      checksum: `checksum-${page.handle}-v1`,
    })),
  )
  await upsertQueryClusters(
    db,
    scope,
    extra.map((page) => ({ headQuery: page.query, memberQueries: [page.query] })),
  )

  const rows = []
  for (let back = 0; back < 90; back += 1) {
    const day = new Date(NOW)
    day.setUTCDate(day.getUTCDate() - back)
    for (const page of extra) {
      rows.push({
        date: day.toISOString().slice(0, 10),
        page: page.url,
        query: page.query,
        device: 'desktop',
        country: 'gbr',
        clicks: 3,
        impressions: 200,
        position: 11,
      })
    }
  }
  await upsertGscQueryDaily(db, scope, rows)
  return extra
}

async function queuedKeys(): Promise<string[]> {
  const { rows } = await harness.pool.query<{ key: string }>(
    `select j.key from graphile_worker._private_jobs as j
      join graphile_worker._private_tasks as t on t.id = j.task_id
     where t.identifier = $1
     order by j.key`,
    [INTENT_GAP_ACCOUNT_TASK],
  )
  return rows.map((r) => r.key)
}
