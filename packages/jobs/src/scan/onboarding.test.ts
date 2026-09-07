import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { silentLogger } from '@sortiva/core'
import { MockSeoDataProvider } from '@sortiva/providers/seo/mock'
import {
  accountScope,
  findOpportunityById,
  insertMinimalOpportunity,
  listTopicsInRange,
} from '@sortiva/db'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { rules } from '@sortiva/rules'
import { runOnboardingScan } from './onboarding'

/**
 * The first calendar a store ever gets. Its one status write — taking a
 * candidate out of the accepted pool the moment it lands on a day — is the
 * thing that stops a redelivered onboarding job putting the same subject on
 * the calendar twice, and it is the only place in the product that write is
 * made outside the weekly replenishment.
 */

const available = await databaseAvailable()
const NOW = new Date('2026-09-07T07:00:00Z')

describe.skipIf(!available)('the calendar an onboarding scan seeds', () => {
  let ctx: TestDb
  let accountId: string

  beforeAll(async () => {
    ctx = await setupTestDb('scan_onboarding')
  })

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(ctx.pool)
    accountId = await insertAccount(ctx.pool, 'onboarding-scan@example.com')
  })

  const announced: string[] = []

  function deps() {
    announced.length = 0
    return {
      db: ctx.db,
      pool: ctx.pool,
      seo: new MockSeoDataProvider({}),
      capture: { capture: () => {} },
      now: () => NOW,
      logger: silentLogger,
      notifications: {
        emit: async (type: string) => {
          announced.push(type)
          return { created: true }
        },
      },
    } as never
  }

  /** One candidate waiting to be given a day, carrying what the calendar needs to place it. */
  async function waitingCandidate(entityRef: string): Promise<string> {
    const row = await insertMinimalOpportunity(
      ctx.db,
      accountScope(accountId),
      {
        // A Search Console signal, so this store's catalogue-only scan does not
        // re-measure it and cannot expire the row out from under the test.
        signalType: 'content_decay',
        entityType: 'query_cluster',
        entityRef,
        evidenceJson: [
          { key: 'intent_class', value: 'buying_guide', source: 'catalog', fetchedAt: NOW.toISOString() },
        ],
        recommendedAction: 'refresh',
        status: 'accepted',
        reasonTemplateKey: 'opportunity.content_decay',
        reasonParams: {},
        limitedIntelligence: true,
        rulesVersion: rules().rulesVersion,
      },
      NOW,
    )
    return row.id
  }

  it('gives each waiting candidate a day and takes it out of the pool as it does', async () => {
    const id = await waitingCandidate('trail running shoes')

    const result = await runOnboardingScan(deps(), accountId)

    expect(result.status).toBe('completed')
    expect(result.topicsScheduled).toBe(1)
    expect(announced).toContain('opportunities_ready')

    const topics = await listTopicsInRange(ctx.db, accountScope(accountId), '2026-09-07', '2026-12-31')
    expect(topics).toHaveLength(1)
    expect(topics[0]?.opportunityId).toBe(id)

    const row = await findOpportunityById(ctx.db, accountScope(accountId), id)
    expect(row?.status).toBe('scheduled')
  })

  it('does not give the same candidate a second day when the job is delivered again', async () => {
    await waitingCandidate('trail running shoes')

    await runOnboardingScan(deps(), accountId)
    await runOnboardingScan(deps(), accountId)

    const topics = await listTopicsInRange(ctx.db, accountScope(accountId), '2026-09-07', '2026-12-31')
    expect(topics).toHaveLength(1)
  })
})
