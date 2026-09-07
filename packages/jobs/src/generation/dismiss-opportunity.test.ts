import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { OPPORTUNITY_STATUS_CHANGED_EVENT, publishMarker, topicFingerprint } from '@sortiva/core'
import {
  accountScope,
  articlesReadyForDelivery,
  findPlannedTopicOnDate,
  insertArticleStub,
  insertGateDecision,
  insertMinimalOpportunity,
  insertTopic,
  markArticleDelivered,
  occupiedDatesInRange,
  schema,
  strandedGeneratingTopicsBefore,
  type Db,
  type OpportunityRow,
  type TopicRow,
} from '@sortiva/db'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { dismissOpportunity } from './veto-topic'

/**
 * Saying "not interested" to a suggestion calls off the article it booked.
 *
 * Four things are proved here against real Postgres rather than asserted from
 * the SQL: the cancelled day is left empty rather than handed to something
 * else; a run already writing is stopped and does not look to the interrupted-
 * day sweep like one to rescue; the article such a run goes on to write is
 * never delivered; and a publication landing at the same moment takes the whole
 * dismissal with it rather than half of it.
 */

const available = await databaseAvailable()
const NOW = new Date('2026-03-10T08:00:00.000Z')
const SCHEDULED = '2026-03-15'

describe.skipIf(!available)('dismissing a suggestion calls off its calendar day', () => {
  let ctx: TestDb
  let db: Db
  let accountId: string

  beforeAll(async () => {
    ctx = await setupTestDb('generation_dismiss_opportunity')
    db = ctx.db as unknown as Db
  })

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(ctx.pool)
    accountId = await insertAccount(ctx.pool, 'dismiss-calendar@example.com')
  })

  async function seedOpportunity(status: OpportunityRow['status'] = 'scheduled'): Promise<OpportunityRow> {
    return insertMinimalOpportunity(
      db,
      accountScope(accountId),
      {
        signalType: 'uncovered_commercial_query',
        entityType: 'query_cluster',
        entityRef: 'best trail running shoes',
        evidenceJson: [],
        recommendedAction: 'create',
        status,
        reasonTemplateKey: 'gate1.admitted',
        reasonParams: {},
        limitedIntelligence: false,
        rulesVersion: 'a'.repeat(64),
      },
      NOW,
    )
  }

  async function seedBookedDay(state: TopicRow['state'] = 'planned'): Promise<{
    opportunity: OpportunityRow
    topic: TopicRow
  }> {
    const opportunity = await seedOpportunity()
    const topic = await insertTopic(
      db,
      accountScope(accountId),
      {
        opportunityId: opportunity.id,
        title: 'Best trail running shoes',
        targetKeyword: 'best trail running shoes',
        keywordCluster: null,
        intentClass: 'buying_guide',
        familyIds: [],
        kind: 'new',
        source: 'auto',
        whyLine: 'topic.auto',
        scheduledDate: SCHEDULED,
        pinned: false,
        state,
      },
      NOW,
    )
    return { opportunity, topic }
  }

  it('removes a planned day and leaves it a gap rather than filling it', async () => {
    const { opportunity, topic } = await seedBookedDay('planned')
    const scope = accountScope(accountId)

    const captured: unknown[] = []
    const result = await dismissOpportunity(
      { db, now: () => NOW, capture: { capture: (e) => captured.push(e) } },
      { accountId, opportunityId: opportunity.id },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected the dismissal to succeed')
    expect(result.topic?.id).toBe(topic.id)
    expect(result.topic?.state).toBe('vetoed')

    const [stored] = await db.select().from(schema.opportunities).where(eq(schema.opportunities.id, opportunity.id))
    expect(stored?.status).toBe('dismissed')

    // The day is empty: the writing cycle asks for a `planned` topic on that
    // exact date and finds none, so nothing is written and nothing is pulled
    // forward into it.
    expect(await findPlannedTopicOnDate(db, scope, SCHEDULED)).toBeUndefined()
    const occupied = await occupiedDatesInRange(db, scope, SCHEDULED, SCHEDULED)
    expect(occupied.has(SCHEDULED)).toBe(false)

    // And it is never re-proposed, so the same article cannot come back a
    // month later as a replenishment candidate.
    const notInterested = await db
      .select()
      .from(schema.notInterested)
      .where(eq(schema.notInterested.accountId, accountId))
    expect(notInterested.map((r) => r.topicFingerprint)).toEqual([topicFingerprint('best trail running shoes')])

    const events = captured as { event: string; properties: { from: string; to: string } }[]
    expect(events).toHaveLength(1)
    expect(events[0]?.event).toBe(OPPORTUNITY_STATUS_CHANGED_EVENT)
    expect(events[0]?.properties).toMatchObject({ from: 'scheduled', to: 'dismissed' })
  })

  it('stops a run already writing: the draft is discarded and the day is not left looking interrupted', async () => {
    const { opportunity, topic } = await seedBookedDay('generating')
    const scope = accountScope(accountId)
    await insertArticleStub(
      db,
      scope,
      { topicId: topic.id, title: topic.title, slug: 'best-trail-running-shoes', targetKeyword: topic.targetKeyword, state: 'draft' },
      NOW,
    )

    const result = await dismissOpportunity({ db, now: () => NOW }, { accountId, opportunityId: opportunity.id })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected the dismissal to succeed')
    expect(result.draftDiscarded).toBe(true)

    const [article] = await db.select().from(schema.articles).where(eq(schema.articles.topicId, topic.id))
    expect(article?.state).toBe('discarded')

    // The sweep that finishes days whose writing died must not read a
    // deliberately cancelled day as one to rescue.
    const stranded = await strandedGeneratingTopicsBefore(db, scope, '2026-03-20')
    expect(stranded.map((t) => t.id)).not.toContain(topic.id)
  })

  it('never delivers the article a cancelled run goes on to write', async () => {
    const { opportunity, topic } = await seedBookedDay('generating')
    const scope = accountScope(accountId)

    // Cancelled before the writing had produced anything to discard.
    const result = await dismissOpportunity({ db, now: () => NOW }, { accountId, opportunityId: opportunity.id })
    expect(result.ok).toBe(true)

    // The run finishes anyway — the spend is already made — and its article
    // passes the quality bar, which is what would otherwise put it on the shop.
    const article = await insertArticleStub(
      db,
      scope,
      { topicId: topic.id, title: topic.title, slug: 'best-trail-running-shoes', targetKeyword: topic.targetKeyword, state: 'draft' },
      NOW,
    )
    await insertGateDecision(
      db,
      scope,
      { topicId: topic.id, gate: 3, outcome: 'passed', scoresJson: {}, reasonUserFacing: null },
      NOW,
    )

    const ready = await articlesReadyForDelivery(db, scope)
    expect(ready.map((a) => a.id)).not.toContain(article.id)
  })

  it('refuses while a publication of the same article is claimed and unconfirmed', async () => {
    const { opportunity, topic } = await seedBookedDay('generating')
    const scope = accountScope(accountId)
    const article = await insertArticleStub(
      db,
      scope,
      { topicId: topic.id, title: topic.title, slug: 'best-trail-running-shoes', targetKeyword: topic.targetKeyword, state: 'draft' },
      NOW,
    )
    // The claim exists but is unconfirmed: the post may already be on the
    // merchant's shop while our own row still calls the article a draft.
    await db
      .insert(schema.publishIntents)
      .values({ accountId, articleExternalId: publishMarker(article.id), revisionN: 0 })

    const result = await dismissOpportunity({ db, now: () => NOW }, { accountId, opportunityId: opportunity.id })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.refusal).toBe('topic_resolved')

    // Nothing moved.
    const [stored] = await db.select().from(schema.opportunities).where(eq(schema.opportunities.id, opportunity.id))
    expect(stored?.status).toBe('scheduled')
    const [day] = await db.select().from(schema.topics).where(eq(schema.topics.id, topic.id))
    expect(day?.state).toBe('generating')
  })

  it('a dismissal racing a publication leaves no half-applied state', async () => {
    const { opportunity, topic } = await seedBookedDay('generating')
    const scope = accountScope(accountId)
    const article = await insertArticleStub(
      db,
      scope,
      { topicId: topic.id, title: topic.title, slug: 'best-trail-running-shoes', targetKeyword: topic.targetKeyword, state: 'draft' },
      NOW,
    )

    const [dismissal, delivered] = await Promise.all([
      dismissOpportunity({ db, now: () => NOW }, { accountId, opportunityId: opportunity.id }),
      markArticleDelivered(db, scope, article.id, 'export', NOW),
    ])

    const dismissalWon = dismissal.ok
    const publishWon = delivered !== undefined
    // Exactly one of them moved anything. Never both, never neither.
    expect(dismissalWon !== publishWon).toBe(true)

    const [storedArticle] = await db.select().from(schema.articles).where(eq(schema.articles.id, article.id))
    const [storedTopic] = await db.select().from(schema.topics).where(eq(schema.topics.id, topic.id))
    const [storedOpportunity] = await db
      .select()
      .from(schema.opportunities)
      .where(eq(schema.opportunities.id, opportunity.id))

    if (dismissalWon) {
      expect(storedArticle?.state).toBe('discarded')
      expect(storedTopic?.state).toBe('vetoed')
      expect(storedOpportunity?.status).toBe('dismissed')
    } else {
      // The publication won, so every part of the dismissal rolled back: the
      // merchant is never told a suggestion was dropped while its article is
      // on their site.
      expect(storedArticle?.state).toBe('published')
      // The calendar day follows its article out. This read `generating` until
      // `R-OVERRIDE-TOPIC`, because nothing ever moved a topic to `published` —
      // which is what let an overridden topic sit in `rejected_by_gate` for ever
      // and be counted as held back weeks later.
      expect(storedTopic?.state).toBe('published')
      // The publication finishes the suggestion on its way out, so the losing
      // dismissal finds nothing of its own left behind.
      expect(storedOpportunity?.status).toBe('completed')
      const notInterested = await db
        .select()
        .from(schema.notInterested)
        .where(eq(schema.notInterested.accountId, accountId))
      expect(notInterested).toHaveLength(0)
    }
  })

  it('loses to a publication that commits underneath it, and rolls back every part', async () => {
    const { opportunity, topic } = await seedBookedDay('generating')
    const scope = accountScope(accountId)
    const article = await insertArticleStub(
      db,
      scope,
      { topicId: topic.id, title: topic.title, slug: 'best-trail-running-shoes', targetKeyword: topic.targetKeyword, state: 'draft' },
      NOW,
    )

    // The publication holds the article row, uncommitted — the exact instant a
    // dismissal has to lose, forced rather than hoped for.
    const publisher = await ctx.pool.connect()
    let result: Awaited<ReturnType<typeof dismissOpportunity>>
    try {
      await publisher.query('BEGIN')
      await publisher.query(
        `UPDATE articles SET state = 'published', published_at = now() WHERE id = $1 AND state = 'draft'`,
        [article.id],
      )

      const pending = dismissOpportunity({ db, now: () => NOW }, { accountId, opportunityId: opportunity.id })
      // Long enough for the dismissal to reach its own write and block on the
      // row the publication is holding.
      await new Promise((resolve) => setTimeout(resolve, 150))
      await publisher.query('COMMIT')
      result = await pending
    } finally {
      publisher.release()
    }

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected the dismissal to lose')
    expect(result.refusal).toBe('topic_resolved')

    const [storedArticle] = await db.select().from(schema.articles).where(eq(schema.articles.id, article.id))
    const [storedTopic] = await db.select().from(schema.topics).where(eq(schema.topics.id, topic.id))
    const [storedOpportunity] = await db
      .select()
      .from(schema.opportunities)
      .where(eq(schema.opportunities.id, opportunity.id))
    expect(storedArticle?.state).toBe('published')
    expect(storedTopic?.state).toBe('generating')
    expect(storedOpportunity?.status).toBe('scheduled')
    const notInterested = await db
      .select()
      .from(schema.notInterested)
      .where(eq(schema.notInterested.accountId, accountId))
    expect(notInterested).toHaveLength(0)
  })

  it('wins against a publication that arrives after it, and the publication stops', async () => {
    const { opportunity, topic } = await seedBookedDay('generating')
    const scope = accountScope(accountId)
    const article = await insertArticleStub(
      db,
      scope,
      { topicId: topic.id, title: topic.title, slug: 'best-trail-running-shoes', targetKeyword: topic.targetKeyword, state: 'draft' },
      NOW,
    )

    const result = await dismissOpportunity({ db, now: () => NOW }, { accountId, opportunityId: opportunity.id })
    expect(result.ok).toBe(true)

    // The publish hour's own guarded hand-over, arriving a moment later.
    const delivered = await markArticleDelivered(db, scope, article.id, 'export', NOW)
    expect(delivered).toBeUndefined()

    const [storedArticle] = await db.select().from(schema.articles).where(eq(schema.articles.id, article.id))
    expect(storedArticle?.state).toBe('discarded')
  })

  it('dismisses a suggestion that never booked a day, exactly as before', async () => {
    const opportunity = await seedOpportunity('new')

    const result = await dismissOpportunity({ db, now: () => NOW }, { accountId, opportunityId: opportunity.id })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected the dismissal to succeed')
    expect(result.topic).toBeNull()

    const [stored] = await db.select().from(schema.opportunities).where(eq(schema.opportunities.id, opportunity.id))
    expect(stored?.status).toBe('dismissed')
    // Nothing about the calendar is touched for a suggestion that booked no day.
    const notInterested = await db
      .select()
      .from(schema.notInterested)
      .where(eq(schema.notInterested.accountId, accountId))
    expect(notInterested).toHaveLength(0)
  })

  it('refuses a suggestion that has already moved on', async () => {
    const opportunity = await seedOpportunity('completed')

    const result = await dismissOpportunity({ db, now: () => NOW }, { accountId, opportunityId: opportunity.id })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.refusal).toBe('opportunity_not_open')
  })

  it('dismisses a suggestion whose article has already gone out, without pretending to call it back', async () => {
    const { opportunity, topic } = await seedBookedDay('generating')
    const scope = accountScope(accountId)
    const article = await insertArticleStub(
      db,
      scope,
      { topicId: topic.id, title: topic.title, slug: 'best-trail-running-shoes', targetKeyword: topic.targetKeyword, state: 'draft' },
      NOW,
    )
    // Written straight to the row rather than through the publish hand-over,
    // because the hand-over now finishes the suggestion itself. What this test
    // is about is the *lookup* — that a day whose article is already out is not
    // treated as still bookable — and the only rows that can still reach it are
    // ones published before publication started closing suggestions.
    await db
      .update(schema.articles)
      .set({ state: 'published', delivery: 'export', publishedAt: NOW, updatedAt: NOW })
      .where(eq(schema.articles.id, article.id))

    const result = await dismissOpportunity({ db, now: () => NOW }, { accountId, opportunityId: opportunity.id })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected the dismissal to succeed')

    const [stored] = await db.select().from(schema.opportunities).where(eq(schema.opportunities.id, opportunity.id))
    expect(stored?.status).toBe('dismissed')
    const [storedArticle] = await db.select().from(schema.articles).where(eq(schema.articles.id, article.id))
    expect(storedArticle?.state).toBe('published')
  })
})
