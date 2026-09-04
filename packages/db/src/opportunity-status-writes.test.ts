import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { InvalidOpportunityTransitionError, type RankedOpportunityDraft } from '@sortiva/core'
import { accountScope } from './scope'
import {
  dismissOpportunity,
  dismissOpportunityGuarded,
  expireOpportunity,
  undismissOpportunity,
  upsertOpportunity,
} from './repositories/opportunities'
import { markOpportunityApplied, releaseAbandonedOptimizeGenerations } from './repositories/optimize'
import { completeRepair } from './repositories/repair'
import { OPEN_OPPORTUNITY_STATUSES } from './schema'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from './testing'

/**
 * Each of these functions is willing to move a row out of a set of statuses it
 * names for itself. Now that a status write asks the lifecycle first, a status
 * in one of those sets that the lifecycle has no edge for is not a note in a
 * report — it is a working feature that throws.
 *
 * So rather than reading the two lists side by side and asserting they match,
 * this runs every function from every status it admits, against a real
 * database. A disagreement anywhere shows up as a failure here.
 */

const available = await databaseAvailable()

function draft(overrides: Partial<RankedOpportunityDraft> = {}): RankedOpportunityDraft {
  return {
    accountId: 'placeholder',
    signalType: 'competitor_coverage_gap',
    entityType: 'query_cluster',
    entityRef: 'waterproof hiking boots',
    evidence: [
      {
        key: 'keyword',
        value: 'waterproof hiking boots',
        source: 'content_inventory',
        fetchedAt: '2026-01-29T06:00:00.000Z',
      },
    ],
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
    tasks: [],
    impactScore: 80,
    impact: 'high',
    ...overrides,
  }
}

describe.skipIf(!available)('every status write, run from every status its own guard admits', () => {
  let ctx: TestDb
  let pool: pg.Pool
  let accountId: string

  beforeAll(async () => {
    ctx = await setupTestDb('opportunity_status_writes')
    pool = ctx.pool
  })

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(pool)
    accountId = await insertAccount(pool, 'status-writes@example.com')
  })

  /** A row sitting in exactly the status we want to move it out of. */
  async function rowIn(
    status: string,
    overrides: Partial<RankedOpportunityDraft> = {},
  ): Promise<string> {
    const scope = accountScope(accountId)
    const { row } = await upsertOpportunity(ctx.db, scope, {
      ...draft({ entityRef: `entity-${status}-${Math.random()}`, ...overrides }),
      accountId,
    })
    await pool.query('UPDATE opportunities SET status = $1::opportunity_status WHERE id = $2', [
      status,
      row.id,
    ])
    return row.id
  }

  async function statusOf(id: string): Promise<string> {
    const { rows } = await pool.query<{ status: string }>(
      'SELECT status FROM opportunities WHERE id = $1',
      [id],
    )
    return rows[0]!.status
  }

  it('expires a row from every status it is still open in', async () => {
    for (const from of OPEN_OPPORTUNITY_STATUSES) {
      const id = await rowIn(from)
      const expired = await expireOpportunity(ctx.db, accountScope(accountId), id, 'demand_lost')
      expect(expired?.status, `expiring from ${from}`).toBe('expired')
    }
  })

  it('dismisses a row from every status it is still open in — including one being worked on', async () => {
    for (const from of OPEN_OPPORTUNITY_STATUSES) {
      const id = await rowIn(from)
      const result = await dismissOpportunityGuarded(ctx.db, accountScope(accountId), id)
      expect(result?.from, `dismissing from ${from}`).toBe(from)
      expect(await statusOf(id)).toBe('dismissed')
    }
  })

  it('dismisses through the not-interested writer from every open status too', async () => {
    for (const from of OPEN_OPPORTUNITY_STATUSES) {
      const id = await rowIn(from)
      const dismissed = await dismissOpportunity(ctx.db, accountScope(accountId), id)
      expect(dismissed?.status, `dismissing from ${from}`).toBe('dismissed')
    }
  })

  it('undoes a dismissal back to new', async () => {
    const id = await rowIn('dismissed')
    const undone = await undismissOpportunity(ctx.db, accountScope(accountId), id)
    expect(undone?.status).toBe('new')
  })

  it('accepts "I applied this" from every status the row is still open in', async () => {
    for (const from of OPEN_OPPORTUNITY_STATUSES) {
      const id = await rowIn(from, { recommendedAction: 'OPTIMIZE' })
      const applied = await markOpportunityApplied(ctx.db, accountScope(accountId), id)
      expect(applied?.status, `marking applied from ${from}`).toBe('completed')
    }
  })

  it('hands an abandoned generation back to the merchant', async () => {
    const id = await rowIn('executing', { recommendedAction: 'OPTIMIZE' })
    await pool.query("UPDATE opportunities SET updated_at = now() - interval '2 hours' WHERE id = $1", [id])
    const released = await releaseAbandonedOptimizeGenerations(
      ctx.db,
      accountScope(accountId),
      new Date(),
    )
    expect(released).toEqual([id])
    expect(await statusOf(id)).toBe('accepted')
  })

  it('completes a repair from every status the row is still open in', async () => {
    for (const from of OPEN_OPPORTUNITY_STATUSES) {
      const id = await rowIn(from, { signalType: 'broken_product_reference', entityType: 'article' })
      const closed = await completeRepair(ctx.db, accountScope(accountId), id, { repair: {} })
      expect(closed, `completing a repair from ${from}`).toBe(true)
      expect(await statusOf(id)).toBe('completed')
    }
  })

  /**
   * The refusal has to bite, or every walk above is a walk through a door that
   * was never shut. A finished row is the clearest case: nothing in the product
   * reopens one, so asking to is a mistake and gets an error rather than a
   * silent write.
   */
  it('raises rather than writes when the move is one the lifecycle does not draw', async () => {
    const id = await rowIn('completed')
    await expect(
      markOpportunityAppliedFromCompleted(ctx.db, accountScope(accountId), id),
    ).rejects.toThrow(InvalidOpportunityTransitionError)
    expect(await statusOf(id)).toBe('completed')
  })
})

/**
 * Asks for a move nobody drew — reopening a finished row — through the same
 * mover every caller uses, so the refusal proved here is the one that runs in
 * the product rather than a copy of it.
 */
async function markOpportunityAppliedFromCompleted(
  db: TestDb['db'],
  scope: ReturnType<typeof accountScope>,
  id: string,
): Promise<unknown> {
  const { transitionOpportunityStatus } = await import('./repositories/opportunities')
  return transitionOpportunityStatus(db, scope, id, { from: ['completed'], to: 'accepted' })
}
