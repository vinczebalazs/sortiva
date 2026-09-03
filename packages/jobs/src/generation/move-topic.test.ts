import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { accountScope, insertMinimalOpportunity, insertTopic, schema, type Db } from '@sortiva/db'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { moveTopic } from './move-topic'

const available = await databaseAvailable()
const NOW = new Date('2026-03-10T08:00:00.000Z')

describe.skipIf(!available)('moveTopic against real data', () => {
  let ctx: TestDb
  let db: Db
  let accountId: string

  beforeAll(async () => {
    ctx = await setupTestDb('generation_move_topic')
    db = ctx.db as unknown as Db
  })

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(ctx.pool)
    accountId = await insertAccount(ctx.pool, 'move-topic@example.com')
  })

  async function seedTopic(date: string, opts: { pinned?: boolean; state?: 'planned' | 'generating' } = {}) {
    const scope = accountScope(accountId)
    const opportunity = await insertMinimalOpportunity(
      db,
      scope,
      {
        signalType: 'uncovered_commercial_query',
        entityType: 'query_cluster',
        entityRef: `q-${date}`,
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
        title: `Topic for ${date}`,
        targetKeyword: `keyword ${date}`,
        keywordCluster: null,
        intentClass: 'buying_guide',
        familyIds: [],
        kind: 'new',
        source: 'auto',
        whyLine: 'topic.auto',
        scheduledDate: date,
        pinned: opts.pinned ?? false,
        state: opts.state ?? 'planned',
      },
      NOW,
    )
  }

  it('moves a planned topic onto an empty future day', async () => {
    const topic = await seedTopic('2026-03-20')

    const result = await moveTopic({ db, now: () => NOW }, { accountId, topicId: topic.id, toDate: '2026-03-25' })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.topic.scheduledDate).toBe('2026-03-25')
  })

  it('rejects a drag onto a pinned day', async () => {
    const dragged = await seedTopic('2026-03-20')
    await seedTopic('2026-03-25', { pinned: true })

    const result = await moveTopic({ db, now: () => NOW }, { accountId, topicId: dragged.id, toDate: '2026-03-25' })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a conflict')
    expect(result.code).toBe('topic_pinned')

    const [row] = await db.select().from(schema.topics).where(eq(schema.topics.id, dragged.id))
    expect(row?.scheduledDate).toBe('2026-03-20')
  })

  it('refuses to move a pinned topic itself', async () => {
    const topic = await seedTopic('2026-03-20', { pinned: true })

    const result = await moveTopic({ db, now: () => NOW }, { accountId, topicId: topic.id, toDate: '2026-03-25' })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a conflict')
    expect(result.code).toBe('topic_pinned')
  })

  it('swaps with an unpinned occupant rather than rejecting', async () => {
    const dragged = await seedTopic('2026-03-20')
    const occupant = await seedTopic('2026-03-25')

    const result = await moveTopic({ db, now: () => NOW }, { accountId, topicId: dragged.id, toDate: '2026-03-25' })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.topic.scheduledDate).toBe('2026-03-25')

    const [occupantRow] = await db.select().from(schema.topics).where(eq(schema.topics.id, occupant.id))
    expect(occupantRow?.scheduledDate).toBe('2026-03-20')
  })

  it('refuses a date in the past', async () => {
    const topic = await seedTopic('2026-03-20')

    const result = await moveTopic({ db, now: () => NOW }, { accountId, topicId: topic.id, toDate: '2026-03-01' })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a conflict')
    expect(result.code).toBe('calendar_date_in_past')
  })

  it('refuses to move a topic that already started generating', async () => {
    const topic = await seedTopic('2026-03-20', { state: 'generating' })

    const result = await moveTopic({ db, now: () => NOW }, { accountId, topicId: topic.id, toDate: '2026-03-25' })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a conflict')
    expect(result.code).toBe('topic_already_generating')
  })
})
