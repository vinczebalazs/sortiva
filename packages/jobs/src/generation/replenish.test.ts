import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { fixtureCreateOpportunity, type Opportunity, type OpportunitySource } from '@sortiva/core'
import {
  accountScope,
  findOpportunityById,
  insertMinimalOpportunity,
  insertTopic,
  listTopicsInRange,
  type Db,
} from '@sortiva/db'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { rules, type SignalType } from '@sortiva/rules'
import { replenishCalendarForAccount, REPLENISHMENT_COMPLETED_EVENT } from './replenish'

/**
 * The calendar filling itself back up, against a real database.
 *
 * The three things worth proving here rather than in the pure planner's own
 * tests are the three that involve rows: that a pinned topic survives being
 * planned around twice, that every day it writes carries a why-line and the
 * opportunity that produced it, and that an opportunity it has placed cannot
 * be placed a second time.
 */

const available = await databaseAvailable()
const NOW = new Date('2026-03-10T08:00:00.000Z')
const TODAY = '2026-03-10'
/** Tomorrow through the configured target horizon: the days one run has to offer on an empty calendar. */
const SLOTS = rules().defaults.learning.replenishment_target_horizon_days

class FixtureOpportunitySource implements OpportunitySource {
  constructor(private readonly pool: readonly Opportunity[]) {}
  calls = 0
  async acceptedContentOpportunities(): Promise<readonly Opportunity[]> {
    this.calls += 1
    return this.pool
  }
}

describe.skipIf(!available)('replenishment against real data', () => {
  let ctx: TestDb
  let db: Db
  let accountId: string
  const captured: { event: string; properties?: Record<string, unknown> }[] = []

  beforeAll(async () => {
    ctx = await setupTestDb('generation_replenish')
    db = ctx.db as unknown as Db
  })

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(ctx.pool)
    accountId = await insertAccount(ctx.pool, 'replenish@example.com')
    captured.length = 0
  })

  const capture = {
    capture: (event: { event: string; properties?: Record<string, unknown> }) => {
      captured.push({ event: event.event, ...(event.properties ? { properties: event.properties } : {}) })
    },
  }

  async function acceptedOpportunity(over: {
    readonly entityRef: string
    readonly signalType?: SignalType
    readonly action?: 'create' | 'refresh'
    readonly impactScore?: number
    readonly intentClass?: string
  }): Promise<Opportunity> {
    const scope = accountScope(accountId)
    const row = await insertMinimalOpportunity(
      db,
      scope,
      {
        signalType: over.signalType ?? 'uncovered_commercial_query',
        entityType: 'query_cluster',
        entityRef: over.entityRef,
        evidenceJson: [],
        recommendedAction: over.action ?? 'create',
        status: 'accepted',
        reasonTemplateKey: fixtureCreateOpportunity.reasonTemplateKey,
        reasonParams: fixtureCreateOpportunity.reasonParams,
        limitedIntelligence: false,
        rulesVersion: fixtureCreateOpportunity.rulesVersion,
      },
      NOW,
    )
    return {
      ...fixtureCreateOpportunity,
      id: row.id,
      accountId,
      signalType: over.signalType ?? 'uncovered_commercial_query',
      recommendedAction: over.action === 'refresh' ? 'REFRESH' : 'CREATE',
      impactScore: over.impactScore ?? 50,
      entityRef: { kind: 'query_cluster', id: over.entityRef, label: over.entityRef },
      evidence: [
        {
          key: 'intent_class',
          value: over.intentClass ?? 'buying_guide',
          source: 'catalog',
          fetchedAt: NOW.toISOString(),
        },
      ],
    }
  }

  function deps(pool: readonly Opportunity[]) {
    return { db, pool: ctx.pool, opportunities: new FixtureOpportunitySource(pool), capture, now: () => NOW }
  }

  /** Everything replenishment itself put on the calendar — the blockers a test planted are excluded by title. */
  async function placedTopics() {
    const topics = await listTopicsInRange(db, accountScope(accountId), TODAY, '2026-12-31')
    return topics.filter((t) => !t.title.startsWith('blocked '))
  }

  it('fills the open days, and every filled day carries a why-line and the opportunity behind it', async () => {
    const opportunities = await Promise.all(
      Array.from({ length: 4 }, (_, i) => acceptedOpportunity({ entityRef: `q-${i}`, impactScore: 90 - i })),
    )

    const result = await replenishCalendarForAccount(deps(opportunities), accountId)
    expect(result.status).toBe('filled')

    const topics = await listTopicsInRange(db, accountScope(accountId), TODAY, '2026-12-31')
    expect(topics).toHaveLength(4)
    for (const topic of topics) {
      expect(topic.whyLine).toBeTruthy()
      expect(topic.opportunityId).toBeTruthy()
      expect(topic.state).toBe('planned')
      expect(topic.score).not.toBeNull()
      // Never today: the day's dequeue may already have run.
      expect(topic.scheduledDate > TODAY).toBe(true)
    }
    // Highest score gets the earliest open day.
    const earliest = [...topics].sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate))[0]!
    expect(earliest.opportunityId).toBe(opportunities[0]!.id)

    const event = captured.find((c) => c.event === REPLENISHMENT_COMPLETED_EVENT)
    expect(event?.properties).toMatchObject({ candidates_scored: 4, slots_filled: 4 })
    // Main §14.7: ids and aggregates only. No title, no keyword, no prose.
    expect(JSON.stringify(event?.properties)).not.toContain('q-0')
  })

  it('leaves a pinned topic exactly where it is, across two runs', async () => {
    const scope = accountScope(accountId)
    const anchor = await acceptedOpportunity({ entityRef: 'q-pinned' })
    const pinned = await insertTopic(
      db,
      scope,
      {
        opportunityId: anchor.id,
        title: 'Launch day guide',
        targetKeyword: 'launch day guide',
        keywordCluster: null,
        intentClass: 'buying_guide',
        familyIds: [],
        kind: 'new',
        source: 'manual',
        whyLine: 'topic.manual',
        scheduledDate: '2026-03-20',
        pinned: true,
        state: 'planned',
      },
      NOW,
    )

    const pool = await Promise.all(
      Array.from({ length: 5 }, (_, i) => acceptedOpportunity({ entityRef: `q-${i}` })),
    )

    await replenishCalendarForAccount(deps(pool), accountId)
    const afterFirst = (await listTopicsInRange(db, scope, TODAY, '2026-12-31')).find((t) => t.id === pinned.id)
    await replenishCalendarForAccount(deps(pool), accountId)
    const afterSecond = (await listTopicsInRange(db, scope, TODAY, '2026-12-31')).find((t) => t.id === pinned.id)

    expect(afterFirst).toEqual(pinned)
    expect(afterSecond).toEqual(pinned)
  })

  /**
   * The claim is made before the placement is attempted, on purpose: a crash
   * between the two costs one candidate rather than putting two articles on
   * one subject. That only holds if a refused placement can give the claim
   * back — a candidate left marked as being on the calendar with no day is
   * one no later run will ever offer again.
   */
  it('gives the claim back when the placement is refused, instead of stranding the candidate', async () => {
    const scope = accountScope(accountId)
    const stray = await acceptedOpportunity({ entityRef: 'q-no-intent' })
    // Nothing may guess what an article is *for*, so a candidate carrying no
    // intent is refused a day rather than placed on a guessed template.
    const refused: Opportunity = { ...stray, evidence: [] }

    const result = await replenishCalendarForAccount(deps([refused]), accountId)
    expect(result.status).toBe('filled')
    expect(await placedTopics()).toHaveLength(0)

    const row = await findOpportunityById(db, scope, stray.id)
    expect(row?.status).toBe('accepted')
  })

  it('does not hand the same opportunity a second day on a second run', async () => {
    const pool = await Promise.all(
      Array.from({ length: 3 }, (_, i) => acceptedOpportunity({ entityRef: `q-${i}` })),
    )
    const source = new FixtureOpportunitySource(pool)
    const shared = { db, pool: ctx.pool, opportunities: source, capture, now: () => NOW }

    await replenishCalendarForAccount(shared, accountId)
    const first = await listTopicsInRange(db, accountScope(accountId), TODAY, '2026-12-31')
    // The source is a fixture and keeps offering the same pool; the guarded
    // status transition is what has to stop the second placement, not the read.
    await replenishCalendarForAccount(shared, accountId)
    const second = await listTopicsInRange(db, accountScope(accountId), TODAY, '2026-12-31')

    expect(first).toHaveLength(3)
    expect(second).toHaveLength(3)
  })

  it('does nothing when the calendar is already planned past the trigger horizon', async () => {
    const scope = accountScope(accountId)
    const anchor = await acceptedOpportunity({ entityRef: 'q-far' })
    await insertTopic(
      db,
      scope,
      {
        opportunityId: anchor.id,
        title: 'Far out',
        targetKeyword: null,
        keywordCluster: null,
        intentClass: 'buying_guide',
        familyIds: [],
        kind: 'new',
        source: 'auto',
        whyLine: 'topic.auto',
        scheduledDate: '2026-06-01',
        pinned: false,
        state: 'planned',
      },
      NOW,
    )

    const source = new FixtureOpportunitySource([await acceptedOpportunity({ entityRef: 'q-new' })])
    const result = await replenishCalendarForAccount(
      { db, pool: ctx.pool, opportunities: source, capture, now: () => NOW },
      accountId,
    )

    expect(result.status).toBe('not_due')
    // 2026-06-01 is 83 days out, past the 60-day trigger.
    expect(result.horizonDays).toBeGreaterThan(rules().defaults.learning.replenishment_horizon_days)
    // It stopped before even asking what was available.
    expect(source.calls).toBe(0)
    expect(captured).toHaveLength(0)
  })

  it('never re-proposes a subject the merchant deleted', async () => {
    await ctx.pool.query(
      `INSERT INTO not_interested (account_id, topic_fingerprint, vetoed_at) VALUES ($1, $2, now())`,
      [accountId, 'best trail running shoes'],
    )
    const pool = [
      await acceptedOpportunity({ entityRef: 'best trail running shoes' }),
      await acceptedOpportunity({ entityRef: 'best hiking boots' }),
    ]

    await replenishCalendarForAccount(deps(pool), accountId)

    const topics = await listTopicsInRange(db, accountScope(accountId), TODAY, '2026-12-31')
    expect(topics.map((t) => t.title)).toEqual(['best hiking boots'])
  })

  it('holds refreshes to their share of the batch, even when they outscore every new topic', async () => {
    // Every refresh scores above every new topic. Without the cap the whole
    // batch would be refreshes and new coverage would stall, which is the
    // failure main §9.6.5 puts the cap there to prevent.
    const refreshes = await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        acceptedOpportunity({ entityRef: `r-${i}`, action: 'refresh', impactScore: 100 }),
      ),
    )
    const creates = await Promise.all(
      Array.from({ length: 60 }, (_, i) => acceptedOpportunity({ entityRef: `c-${i}`, impactScore: 10 })),
    )

    const result = await replenishCalendarForAccount(deps([...refreshes, ...creates]), accountId)
    expect(result.status).toBe('filled')

    const placed = await placedTopics()
    const refreshed = placed.filter((t) => t.kind === 'refresh')
    // Tomorrow through the 90-day target, inclusive: 90 days, of which floor(90 × 0.40) = 36 may be refreshes.
    expect(placed).toHaveLength(SLOTS)
    expect(refreshed).toHaveLength(Math.floor(SLOTS * rules().defaults.learning.refresh.batch_share_max))
    expect(refreshed.length / placed.length).toBeLessThanOrEqual(
      rules().defaults.learning.refresh.batch_share_max,
    )
  })

  it('reserves days for kinds of article this store has never tried, once it has tried anything', async () => {
    // A winner-dominant pattern on one intent class makes every candidate in
    // that class "explored" and every candidate outside it unexplored. Without
    // the reservation the ten explored candidates would take all ten days and
    // the store would never find out whether how-to articles work for it.
    await ctx.pool.query(
      `INSERT INTO pattern_stats (account_id, dimension, dimension_value, rated_n, winner_n, underperformer_n, multiplier)
       VALUES ($1, 'intent_class', 'buying_guide', 6, 5, 0, 1.25)`,
      [accountId],
    )
    // Exactly as many explored candidates as there are days, so the score pass
    // would otherwise take all of them.
    const explored = await Promise.all(
      Array.from({ length: SLOTS }, (_, i) =>
        acceptedOpportunity({ entityRef: `e-${String(i).padStart(2, '0')}`, impactScore: 90 - i / 10, intentClass: 'buying_guide' }),
      ),
    )
    const unexplored = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        acceptedOpportunity({ entityRef: `u-${i}`, impactScore: 1, intentClass: 'how_to' }),
      ),
    )

    await replenishCalendarForAccount(deps([...explored, ...unexplored]), accountId)

    const placed = await placedTopics()
    expect(placed).toHaveLength(SLOTS)
    const exploration = placed.filter((t) => t.source === 'exploration')
    // The reservation is max(2, ceil(90 × 0.15)) = 14, and only five
    // unexplored candidates exist — so it takes all five and does not invent
    // the rest.
    expect(exploration).toHaveLength(5)
    for (const topic of exploration) expect(topic.whyLine).toBe('replenishment.exploration')
    // And the promotion displaced the weakest explored picks, not the best.
    const titles = placed.map((t) => t.title)
    expect(titles).toContain('e-00')
    expect(titles).not.toContain(`e-${SLOTS - 1}`)
  })
})
