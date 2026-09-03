import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { excludeNotInterested } from '@sortiva/core'
import { accountScope, insertMinimalOpportunity, insertTopic, notInterestedFingerprints, type Db } from '@sortiva/db'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { vetoTopic } from './veto-topic'

/**
 * This card's done-when: "deleted topic fingerprint is never re-proposed by
 * a fixture replenishment." Real replenishment candidate-scoring is T4.6's
 * (not built), so this drives the primitive it will call
 * (`excludeNotInterested`) against a small fixture batch of candidates and a
 * real `not_interested` row written by a real veto.
 */

const available = await databaseAvailable()
const NOW = new Date('2026-03-10T08:00:00.000Z')

describe.skipIf(!available)('a vetoed topic is never re-proposed', () => {
  let ctx: TestDb
  let db: Db
  let accountId: string

  beforeAll(async () => {
    ctx = await setupTestDb('generation_replenishment_guard')
    db = ctx.db as unknown as Db
  })

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(ctx.pool)
    accountId = await insertAccount(ctx.pool, 'replenishment-guard@example.com')
  })

  it('excludes a vetoed candidate from a fixture replenishment batch, case-insensitively', async () => {
    const scope = accountScope(accountId)
    const opportunity = await insertMinimalOpportunity(
      db,
      scope,
      {
        signalType: 'uncovered_commercial_query',
        entityType: 'query_cluster',
        entityRef: 'best trail running shoes',
        evidenceJson: [],
        recommendedAction: 'create',
        status: 'scheduled',
        reasonTemplateKey: 'gate1.admitted',
        reasonParams: {},
        limitedIntelligence: false,
        rulesVersion: 'a'.repeat(64),
      },
      NOW,
    )
    const topic = await insertTopic(
      db,
      scope,
      {
        opportunityId: opportunity.id,
        title: 'Best trail running shoes',
        targetKeyword: 'Best Trail Running Shoes',
        keywordCluster: null,
        intentClass: 'buying_guide',
        familyIds: [],
        kind: 'new',
        source: 'auto',
        whyLine: 'topic.auto',
        scheduledDate: '2026-03-15',
        pinned: false,
        state: 'planned',
      },
      NOW,
    )

    const vetoResult = await vetoTopic({ db, now: () => NOW }, { accountId, topicId: topic.id })
    expect(vetoResult.ok).toBe(true)

    const fingerprints = await notInterestedFingerprints(db, scope)

    const fixtureBatch = [
      { searchTerm: 'best trail running shoes' },
      { searchTerm: '  BEST TRAIL RUNNING SHOES  ' },
      { searchTerm: 'best hiking boots' },
    ]

    const surviving = excludeNotInterested(fixtureBatch, fingerprints)

    expect(surviving).toEqual([{ searchTerm: 'best hiking boots' }])
  })
})
