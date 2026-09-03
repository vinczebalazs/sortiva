import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { accountScope, insertMinimalOpportunity, insertTopic, type Db } from '@sortiva/db'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { pinTopic } from './pin-topic'

const available = await databaseAvailable()
const NOW = new Date('2026-03-10T08:00:00.000Z')

describe.skipIf(!available)('pinTopic against real data', () => {
  let ctx: TestDb
  let db: Db
  let accountId: string

  beforeAll(async () => {
    ctx = await setupTestDb('generation_pin_topic')
    db = ctx.db as unknown as Db
  })

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(ctx.pool)
    accountId = await insertAccount(ctx.pool, 'pin-topic@example.com')
  })

  async function seedTopic(state: 'planned' | 'published' = 'planned') {
    const scope = accountScope(accountId)
    const opportunity = await insertMinimalOpportunity(
      db,
      scope,
      {
        signalType: 'uncovered_commercial_query',
        entityType: 'query_cluster',
        entityRef: 'q-pin',
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
    return insertTopic(
      db,
      scope,
      {
        opportunityId: opportunity.id,
        title: 'Pin me',
        targetKeyword: 'pin me',
        keywordCluster: null,
        intentClass: 'buying_guide',
        familyIds: [],
        kind: 'new',
        source: 'auto',
        whyLine: 'topic.auto',
        scheduledDate: '2026-03-20',
        pinned: false,
        state,
      },
      NOW,
    )
  }

  it('pins a planned topic', async () => {
    const topic = await seedTopic()
    const result = await pinTopic({ db, now: () => NOW }, { accountId, topicId: topic.id, pinned: true })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.topic.pinned).toBe(true)
  })

  it('unpins a pinned topic', async () => {
    const topic = await seedTopic()
    await pinTopic({ db, now: () => NOW }, { accountId, topicId: topic.id, pinned: true })
    const result = await pinTopic({ db, now: () => NOW }, { accountId, topicId: topic.id, pinned: false })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.topic.pinned).toBe(false)
  })

  it('refuses to pin an already-published topic', async () => {
    const topic = await seedTopic('published')
    const result = await pinTopic({ db, now: () => NOW }, { accountId, topicId: topic.id, pinned: true })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a conflict')
    expect(result.code).toBe('topic_already_published')
  })
})
