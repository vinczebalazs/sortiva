import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { silentLogger } from '@sortiva/core'
import { schema, type Db } from '@sortiva/db'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { approveArticle, discardArticle } from './review-article'

/**
 * The merchant's two answers to a draft that is waiting for them, and what
 * each one leaves behind. There is deliberately no third answer — see
 * `packages/core/src/generation/no-editor.test.ts`, which fails if one appears.
 */

const available = await databaseAvailable()
const NOW = new Date('2026-09-03T07:00:00.000Z')

describe.skipIf(!available)('reviewing a draft', () => {
  let ctx: TestDb
  let db: Db
  let accountId: string

  beforeAll(async () => {
    ctx = await setupTestDb('generation_review_article')
    db = ctx.db as unknown as Db
  })

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(ctx.pool)
    accountId = await insertAccount(ctx.pool, 'review@example.com')
  })

  async function seedArticle(
    state: 'draft' | 'in_review' | 'published',
  ): Promise<{ articleId: string; topicId: string }> {
    const [opportunity] = await db
      .insert(schema.opportunities)
      .values({
        accountId,
        signalType: 'uncovered_commercial_query',
        entityType: 'query_cluster',
        entityRef: 'best water bottles',
        evidenceJson: [],
        impact: 'medium',
        impactScore: 50,
        confidence: 50,
        reasonTemplateKey: 'opportunity.uncovered_commercial_query',
        reasonParamsJson: {},
        recommendedAction: 'create',
        status: 'scheduled',
        preconditionsJson: [],
        limitedIntelligence: false,
        rulesVersion: 'test',
      })
      .returning()
    const [topic] = await db
      .insert(schema.topics)
      .values({
        accountId,
        opportunityId: opportunity!.id,
        title: 'Best water bottles',
        targetKeyword: 'best water bottles',
        intentClass: 'buying_guide',
        familyIds: [],
        kind: 'new',
        source: 'auto',
        scheduledDate: '2026-09-03',
        state: state === 'in_review' ? 'in_review' : 'generating',
      })
      .returning()
    const [article] = await db
      .insert(schema.articles)
      .values({
        accountId,
        topicId: topic!.id,
        title: 'Best water bottles',
        slug: 'best-water-bottles',
        targetKeyword: 'best water bottles',
        state,
      })
      .returning()
    return { articleId: article!.id, topicId: topic!.id }
  }

  const deps = () => ({ db, now: () => NOW, logger: silentLogger })

  it('keeps an approved draft and returns it to the delivery path', async () => {
    const { articleId, topicId } = await seedArticle('in_review')

    const result = await approveArticle(deps(), { accountId, articleId })
    expect(result.ok).toBe(true)

    const [article] = await db.select().from(schema.articles).where(eq(schema.articles.id, articleId))
    expect(article!.state).toBe('draft')
    // The calendar entry stays in review until the article actually goes out:
    // approval is permission, not publication.
    const [topic] = await db.select().from(schema.topics).where(eq(schema.topics.id, topicId))
    expect(topic!.state).toBe('in_review')
  })

  it('discards a draft and closes the calendar day with it', async () => {
    const { articleId, topicId } = await seedArticle('in_review')

    const result = await discardArticle(deps(), { accountId, articleId })
    expect(result.ok).toBe(true)

    const [article] = await db.select().from(schema.articles).where(eq(schema.articles.id, articleId))
    expect(article!.state).toBe('discarded')
    const [topic] = await db.select().from(schema.topics).where(eq(schema.topics.id, topicId))
    expect(topic!.state).toBe('vetoed')

    // A discard is a judgement on this article, not on the subject: the search
    // term is not added to the not-interested list, which is what a veto does.
    const notInterested = await db
      .select()
      .from(schema.notInterested)
      .where(eq(schema.notInterested.accountId, accountId))
    expect(notInterested).toHaveLength(0)
  })

  it('refuses both answers on a draft nobody was asked about', async () => {
    const { articleId } = await seedArticle('draft')

    expect(await approveArticle(deps(), { accountId, articleId })).toEqual({
      ok: false,
      code: 'article_not_in_review',
    })
    expect(await discardArticle(deps(), { accountId, articleId })).toEqual({
      ok: false,
      code: 'article_not_in_review',
    })
  })

  it('says so distinctly when the article has already been published', async () => {
    const { articleId } = await seedArticle('published')
    expect(await approveArticle(deps(), { accountId, articleId })).toEqual({
      ok: false,
      code: 'article_already_published',
    })
  })

  it('approving twice changes nothing the second time', async () => {
    const { articleId } = await seedArticle('in_review')
    expect((await approveArticle(deps(), { accountId, articleId })).ok).toBe(true)
    expect(await approveArticle(deps(), { accountId, articleId })).toEqual({
      ok: false,
      code: 'article_not_in_review',
    })
  })

  it('answers not-found for an article belonging to somebody else', async () => {
    const { articleId } = await seedArticle('in_review')
    const otherAccount = await insertAccount(ctx.pool, 'someone-else@example.com')
    expect(await approveArticle(deps(), { accountId: otherAccount, articleId })).toEqual({
      ok: false,
      code: 'not_found',
    })
  })
})
