import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { OPPORTUNITY_STATUS_CHANGED_EVENT, topicFingerprint } from '@sortiva/core'
import {
  accountScope,
  beginGenerating,
  insertArticleStub,
  insertMinimalOpportunity,
  insertTopic,
  schema,
  type Db,
} from '@sortiva/db'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { vetoTopic } from './veto-topic'

/**
 * The veto operation against real Postgres: the guarded transition, the
 * draft-discard for a topic already past dequeue, the not_interested
 * fingerprint, and the opportunity dismissal with its PostHog event.
 *
 * The concurrent-veto-and-dequeue race is this card's own literal done-when
 * ("concurrent veto + dequeue race yields exactly one winner"), proved
 * against the real database rather than asserted from the guard's SQL alone.
 */

const available = await databaseAvailable()
const NOW = new Date('2026-03-10T08:00:00.000Z')

describe.skipIf(!available)('vetoTopic against real data', () => {
  let ctx: TestDb
  let db: Db
  let accountId: string

  beforeAll(async () => {
    ctx = await setupTestDb('generation_veto_topic')
    db = ctx.db as unknown as Db
  })

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(ctx.pool)
    accountId = await insertAccount(ctx.pool, 'veto-topic@example.com')
  })

  async function seedTopic(overrides: { state?: 'planned' | 'generating' | 'in_review'; keyword?: string } = {}) {
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
        targetKeyword: overrides.keyword ?? 'best trail running shoes',
        keywordCluster: null,
        intentClass: 'buying_guide',
        familyIds: [],
        kind: 'new',
        source: 'auto',
        whyLine: 'topic.auto',
        scheduledDate: '2026-03-15',
        pinned: false,
        state: overrides.state ?? 'planned',
      },
      NOW,
    )
    return { opportunity, topic }
  }

  it('vetoes a planned topic and records its fingerprint', async () => {
    const { topic } = await seedTopic()

    const captured: unknown[] = []
    const result = await vetoTopic(
      { db, now: () => NOW, capture: { capture: (e) => captured.push(e) } },
      { accountId, topicId: topic.id },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.topic.state).toBe('vetoed')
    expect(result.draftDiscarded).toBe(false)

    const notInterested = await db.select().from(schema.notInterested).where(eq(schema.notInterested.accountId, accountId))
    expect(notInterested).toHaveLength(1)
    expect(notInterested[0]?.topicFingerprint).toBe(topicFingerprint('best trail running shoes'))

    const events = captured as { event: string; properties: { to: string; actor: string } }[]
    expect(events).toHaveLength(1)
    expect(events[0]?.event).toBe(OPPORTUNITY_STATUS_CHANGED_EVENT)
    expect(events[0]?.properties.to).toBe('dismissed')
    expect(events[0]?.properties.actor).toBe('user')
  })

  it('cancels publication of a generating topic: the topic is vetoed and its draft is discarded, never published', async () => {
    const { topic } = await seedTopic({ state: 'generating' })
    const scope = accountScope(accountId)
    await insertArticleStub(
      db,
      scope,
      { topicId: topic.id, title: topic.title, slug: 'best-trail-running-shoes', targetKeyword: topic.targetKeyword, state: 'draft' },
      NOW,
    )

    const result = await vetoTopic({ db, now: () => NOW }, { accountId, topicId: topic.id })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.topic.state).toBe('vetoed')
    expect(result.draftDiscarded).toBe(true)

    const [article] = await db.select().from(schema.articles).where(eq(schema.articles.topicId, topic.id))
    expect(article?.state).toBe('discarded')
    expect(article?.state).not.toBe('published')
  })

  it('refuses to veto an already-published topic', async () => {
    const { topic } = await seedTopic({ state: 'planned' })
    await db.update(schema.topics).set({ state: 'published' }).where(eq(schema.topics.id, topic.id))

    const result = await vetoTopic({ db, now: () => NOW }, { accountId, topicId: topic.id })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a conflict')
    expect(result.code).toBe('topic_already_published')

    const [row] = await db.select().from(schema.topics).where(eq(schema.topics.id, topic.id))
    expect(row?.state).toBe('published')
  })

  it('a concurrent veto and dequeue on the same planned topic yields exactly one winner', async () => {
    const { topic } = await seedTopic({ state: 'planned' })
    const scope = accountScope(accountId)

    const [vetoResult, dequeueResult] = await Promise.all([
      vetoTopic({ db, now: () => NOW }, { accountId, topicId: topic.id }),
      beginGenerating(db, scope, topic.id, NOW),
    ])

    const vetoWon = vetoResult.ok
    const dequeueWon = dequeueResult !== undefined

    // Exactly one of the two guarded transitions actually moved the row —
    // never both, never neither.
    expect(vetoWon !== dequeueWon).toBe(true)

    const [row] = await db.select().from(schema.topics).where(eq(schema.topics.id, topic.id))
    expect(row?.state).toBe(vetoWon ? 'vetoed' : 'generating')
  })
})
