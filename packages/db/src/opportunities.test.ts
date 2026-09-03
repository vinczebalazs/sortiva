import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import type { RankedOpportunityDraft } from '@sortiva/core'
import { accountScope } from './scope'
import {
  acceptedContentOpportunities,
  dismissOpportunity,
  expireOpportunity,
  insertOpportunityTasks,
  isDismissed,
  listOpenOpportunities,
  transitionOpportunityStatus,
  undismissOpportunity,
  upsertOpportunity,
} from './repositories/opportunities'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from './testing'

/**
 * The dedupe/expiry/dismiss guarantees against a real Postgres — a partial
 * unique index is database behaviour, and the only honest way to prove
 * "re-detection updates the open row" is to actually write twice and count.
 */

const available = await databaseAvailable()

function draft(overrides: Partial<RankedOpportunityDraft> = {}): RankedOpportunityDraft {
  return {
    accountId: 'placeholder',
    signalType: 'competitor_coverage_gap',
    entityType: 'query_cluster',
    entityRef: 'trail running shoes',
    evidence: [{ key: 'keyword', value: 'trail running shoes', source: 'content_inventory', fetchedAt: '2026-01-29T06:00:00.000Z' }],
    confidence: 60,
    confidenceBand: 'medium',
    reasonTemplateKey: 'competitor_coverage_gap.create',
    reasonParams: { competitors: 2 },
    recommendedAction: 'CREATE',
    preconditions: [],
    status: 'accepted',
    rulesVersion: 'test-rules-version',
    limitedIntelligence: false,
    detectedAt: '2026-01-29T06:00:00.000Z',
    rawScore: 5,
    tasks: [{ kind: 'schedule_topic', description: 'Schedule a new article.' }],
    impactScore: 80,
    impact: 'high',
    ...overrides,
  }
}

describe.skipIf(!available)('the opportunities table (main §7.6, §7.9)', () => {
  let ctx: TestDb
  let pool: pg.Pool
  let accountId: string

  beforeAll(async () => {
    ctx = await setupTestDb('opportunities')
    pool = ctx.pool
  })

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(pool)
    accountId = await insertAccount(pool, 'opportunities@example.com')
  })

  it('inserts a first sighting as a new row', async () => {
    const scope = accountScope(accountId)
    const { row, created } = await upsertOpportunity(ctx.db, scope, { ...draft(), accountId })
    expect(created).toBe(true)
    expect(row.signalType).toBe('competitor_coverage_gap')
    expect(row.status).toBe('accepted')
    expect(row.impactScore).toBe(80)
  })

  it('re-running detection on the same signal and entity updates the open row rather than duplicating it', async () => {
    const scope = accountScope(accountId)
    const first = await upsertOpportunity(ctx.db, scope, { ...draft(), accountId })
    expect(first.created).toBe(true)

    const second = await upsertOpportunity(
      ctx.db,
      scope,
      { ...draft({ confidence: 90, impactScore: 95, impact: 'high' }), accountId },
    )
    expect(second.created).toBe(false)
    expect(second.row.id).toBe(first.row.id)
    expect(second.row.confidence).toBe(90)
    expect(second.row.impactScore).toBe(95)

    const open = await listOpenOpportunities(ctx.db, scope)
    expect(open).toHaveLength(1)
  })

  it('does not touch status on a re-detection — a merchant’s progress is never silently reset', async () => {
    const scope = accountScope(accountId)
    const { row } = await upsertOpportunity(ctx.db, scope, { ...draft({ status: 'accepted' }), accountId })
    const scheduled = await transitionOpportunityStatus(ctx.db, scope, row.id, {
      from: ['accepted'],
      to: 'scheduled',
    })
    expect(scheduled?.status).toBe('scheduled')

    const redetected = await upsertOpportunity(ctx.db, scope, { ...draft({ confidence: 99 }), accountId })
    expect(redetected.row.status).toBe('scheduled')
  })

  it('writes the tasks a draft carries, linked to the opportunity', async () => {
    const scope = accountScope(accountId)
    const { row } = await upsertOpportunity(ctx.db, scope, { ...draft(), accountId })
    const tasks = await insertOpportunityTasks(ctx.db, row.id, [...draft().tasks])
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.opportunityId).toBe(row.id)
    expect(tasks[0]!.kind).toBe('schedule_topic')
    expect(tasks[0]!.state).toBe('open')
  })

  it('rejects a guarded transition from the wrong state', async () => {
    const scope = accountScope(accountId)
    const { row } = await upsertOpportunity(ctx.db, scope, { ...draft({ status: 'accepted' }), accountId })
    const result = await transitionOpportunityStatus(ctx.db, scope, row.id, {
      from: ['new'],
      to: 'scheduled',
    })
    expect(result).toBeUndefined()

    const stillAccepted = await listOpenOpportunities(ctx.db, scope)
    expect(stillAccepted[0]?.status).toBe('accepted')
  })

  it('expiry keeps the row — main §7.9 says expiry never deletes', async () => {
    const scope = accountScope(accountId)
    const { row } = await upsertOpportunity(ctx.db, scope, { ...draft(), accountId })
    const expired = await expireOpportunity(ctx.db, scope, row.id, 'evidence_no_longer_holds')
    expect(expired?.status).toBe('expired')
    expect(expired?.expiredReason).toBe('evidence_no_longer_holds')

    // The row still exists, just no longer open.
    const open = await listOpenOpportunities(ctx.db, scope)
    expect(open).toHaveLength(0)
    const { rows } = await pool.query('select count(*)::int as n from opportunities where id = $1', [row.id])
    expect(rows[0]!.n).toBe(1)
  })

  it('an expired opportunity does not block a fresh detection of the same signal and entity', async () => {
    const scope = accountScope(accountId)
    const { row: first } = await upsertOpportunity(ctx.db, scope, { ...draft(), accountId })
    await expireOpportunity(ctx.db, scope, first.id, 'demand_lost')

    const { row: second, created } = await upsertOpportunity(ctx.db, scope, { ...draft(), accountId })
    expect(created).toBe(true)
    expect(second.id).not.toBe(first.id)
  })

  it('dismissing writes the not-interested marker and the marker survives history', async () => {
    const scope = accountScope(accountId)
    const { row } = await upsertOpportunity(ctx.db, scope, { ...draft({ status: 'new' }), accountId })
    const dismissed = await dismissOpportunity(ctx.db, scope, row.id)
    expect(dismissed?.status).toBe('dismissed')
    expect(await isDismissed(ctx.db, scope, row.signalType, row.entityRef)).toBe(true)
  })

  it('undismissing returns the row to new and clears the marker', async () => {
    const scope = accountScope(accountId)
    const { row } = await upsertOpportunity(ctx.db, scope, { ...draft({ status: 'new' }), accountId })
    await dismissOpportunity(ctx.db, scope, row.id)
    const undone = await undismissOpportunity(ctx.db, scope, row.id)
    expect(undone?.status).toBe('new')
    expect(await isDismissed(ctx.db, scope, row.signalType, row.entityRef)).toBe(false)
  })

  it('acceptedContentOpportunities returns only auto-accepted CREATE/REFRESH rows — the OpportunitySource seam', async () => {
    const scope = accountScope(accountId)
    await upsertOpportunity(ctx.db, scope, {
      ...draft({ entityRef: 'a', recommendedAction: 'CREATE', status: 'accepted' }),
      accountId,
    })
    await upsertOpportunity(ctx.db, scope, {
      ...draft({
        entityRef: 'b',
        signalType: 'missing_or_weak_metadata',
        entityType: 'url',
        recommendedAction: 'OPTIMIZE',
        status: 'new',
      }),
      accountId,
    })
    await upsertOpportunity(ctx.db, scope, {
      ...draft({
        entityRef: 'c',
        signalType: 'catalog_richness_gap',
        recommendedAction: 'HOLD',
        status: 'blocked',
        preconditions: ['catalog_richness_gap'],
      }),
      accountId,
    })

    const accepted = await acceptedContentOpportunities(ctx.db, scope)
    expect(accepted).toHaveLength(1)
    expect(accepted[0]!.entityRef).toBe('a')
    expect(accepted[0]!.recommendedAction).toBe('create')
  })

  it('scopes every read and write to the account — no cross-account leak', async () => {
    const otherAccountId = await insertAccount(pool, 'other@example.com')
    const scope = accountScope(accountId)
    const otherScope = accountScope(otherAccountId)
    await upsertOpportunity(ctx.db, scope, { ...draft(), accountId })

    expect(await listOpenOpportunities(ctx.db, otherScope)).toHaveLength(0)
    expect(await acceptedContentOpportunities(ctx.db, otherScope)).toHaveLength(0)
  })
})
