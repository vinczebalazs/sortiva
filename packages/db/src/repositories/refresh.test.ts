import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import {
  articleRefreshCount,
  articleRefreshFacts,
  lastArticleRefreshAt,
  recordArticleRefresh,
} from './refresh'
import { insertMinimalOpportunity } from './opportunities'
import { insertTopic } from './topics'
import { insertArticleStub } from './articles'
import { markArticleDelivered } from './delivery'
import { accountScope } from '../scope'
import type { Db } from '../client'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from '../testing'

/**
 * The rewrite history of our own published articles, against a real Postgres.
 *
 * `refresh_log` carries no account of its own, so the thing most worth proving
 * here is that another store's article id reads as "no such article" rather
 * than as somebody else's history.
 */

const available = await databaseAvailable()
const NOW = new Date('2026-09-07T00:00:00.000Z')

describe.skipIf(!available)('article refresh history', () => {
  let ctx: TestDb
  let db: Db
  let accountId: string
  let otherAccountId: string

  beforeAll(async () => {
    ctx = await setupTestDb('refresh_repo')
    db = ctx.db as unknown as Db
  }, 60_000)

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(ctx.pool)
    accountId = await insertAccount(ctx.pool, 'refresh@example.com')
    otherAccountId = await insertAccount(ctx.pool, 'other@example.com')
  })

  async function publishedArticle(
    ownerId: string,
    over: { readonly override?: boolean; readonly state?: 'published' | 'draft' } = {},
  ): Promise<string> {
    const scope = accountScope(ownerId)
    const opportunity = await insertMinimalOpportunity(
      db,
      scope,
      {
        signalType: 'uncovered_commercial_query',
        entityType: 'query_cluster',
        entityRef: `q-${ownerId}-${Math.random()}`,
        evidenceJson: [],
        recommendedAction: 'create',
        status: 'accepted',
        reasonTemplateKey: 'uncovered_commercial_query.create',
        reasonParams: {},
        limitedIntelligence: false,
        rulesVersion: 'test',
      },
      NOW,
    )
    const topic = await insertTopic(
      db,
      scope,
      {
        opportunityId: opportunity.id,
        title: 'Best trail shoes for wide feet',
        targetKeyword: 'trail shoes wide feet',
        keywordCluster: null,
        intentClass: 'buying_guide',
        familyIds: [],
        kind: 'new',
        source: 'auto',
        whyLine: 'x',
        scheduledDate: '2026-01-01',
        pinned: false,
        state: 'published',
      },
      NOW,
    )
    const article = await insertArticleStub(
      db,
      scope,
      {
        topicId: topic.id,
        title: 'Best trail shoes for wide feet',
        slug: `trail-shoes-${Math.random()}`,
        targetKeyword: 'trail shoes wide feet',
        state: 'draft',
      },
      NOW,
    )
    await db.execute(
      sql`update articles set state = ${over.state ?? 'published'}, published_via_override = ${over.override ?? false} where id = ${article.id}`,
    )
    return article.id
  }

  it('reports no history for an article that has never been rewritten', async () => {
    const articleId = await publishedArticle(accountId)
    expect(await lastArticleRefreshAt(db, accountScope(accountId), articleId)).toBeNull()
    expect(await articleRefreshCount(db, accountScope(accountId), articleId)).toBe(0)
  })

  it('records a rewrite and reads back the most recent one', async () => {
    const articleId = await publishedArticle(accountId)
    const scope = accountScope(accountId)

    expect(await recordArticleRefresh(db, scope, articleId, new Date('2026-05-01T00:00:00.000Z'))).toBe(true)
    expect(await recordArticleRefresh(db, scope, articleId, new Date('2026-08-01T00:00:00.000Z'))).toBe(true)

    expect((await lastArticleRefreshAt(db, scope, articleId))?.toISOString()).toBe('2026-08-01T00:00:00.000Z')
    // Append-only: the second rewrite adds a row, it does not move the first.
    expect(await articleRefreshCount(db, scope, articleId)).toBe(2)
  })

  it('refuses to record a rewrite against another store’s article', async () => {
    const theirs = await publishedArticle(otherAccountId)
    expect(await recordArticleRefresh(db, accountScope(accountId), theirs)).toBe(false)
    expect(await articleRefreshCount(db, accountScope(otherAccountId), theirs)).toBe(0)
  })

  it('does not show one store the rewrite history of another', async () => {
    const theirs = await publishedArticle(otherAccountId)
    await recordArticleRefresh(db, accountScope(otherAccountId), theirs, NOW)

    expect(await lastArticleRefreshAt(db, accountScope(accountId), theirs)).toBeNull()
    expect(await articleRefreshFacts(db, accountScope(accountId), theirs)).toBeNull()
    expect(await articleRefreshFacts(db, accountScope(otherAccountId), theirs)).toMatchObject({
      published: true,
      lastRefreshedAt: NOW.toISOString(),
    })
  })

  it('assembles the facts the eligibility rule reads from our own tables', async () => {
    const articleId = await publishedArticle(accountId, { override: true })
    const facts = await articleRefreshFacts(db, accountScope(accountId), articleId)
    expect(facts).toMatchObject({
      articleId,
      published: true,
      publishedViaOverride: true,
      repairPending: false,
      lastRefreshedAt: null,
    })
  })

  it('reports a draft as not published, so nothing proposes rewriting it', async () => {
    const articleId = await publishedArticle(accountId, { state: 'draft' })
    expect(await articleRefreshFacts(db, accountScope(accountId), articleId)).toMatchObject({
      published: false,
    })
  })

  it('notices an open repair standing against the article', async () => {
    const articleId = await publishedArticle(accountId)
    const scope = accountScope(accountId)
    await insertMinimalOpportunity(
      db,
      scope,
      {
        signalType: 'broken_product_reference',
        entityType: 'article',
        entityRef: articleId,
        evidenceJson: [],
        recommendedAction: 'fix',
        status: 'accepted',
        reasonTemplateKey: 'broken_product_reference.fix',
        reasonParams: {},
        limitedIntelligence: false,
        rulesVersion: 'test',
      },
      NOW,
    )
    expect(await articleRefreshFacts(db, scope, articleId)).toMatchObject({ repairPending: true })
  })

  it('stops treating a repair as pending once it is finished', async () => {
    const articleId = await publishedArticle(accountId)
    const scope = accountScope(accountId)
    const opportunity = await insertMinimalOpportunity(
      db,
      scope,
      {
        signalType: 'product_change_impact',
        entityType: 'article',
        entityRef: articleId,
        evidenceJson: [],
        recommendedAction: 'fix',
        status: 'accepted',
        reasonTemplateKey: 'product_change_impact.product_deleted',
        reasonParams: {},
        limitedIntelligence: false,
        rulesVersion: 'test',
      },
      NOW,
    )
    await db.execute(sql`update opportunities set status = 'completed' where id = ${opportunity.id}`)
    expect(await articleRefreshFacts(db, scope, articleId)).toMatchObject({ repairPending: false })
  })

  it('starts the cooldown when a rewrite actually reaches the merchant, not when it is asked for', async () => {
    const scope = accountScope(accountId)
    const original = await publishedArticle(accountId)

    const rewriteWork = await insertMinimalOpportunity(
      db,
      scope,
      {
        signalType: 'freshness_opportunity',
        entityType: 'article',
        entityRef: original,
        evidenceJson: [],
        recommendedAction: 'refresh',
        status: 'accepted',
        reasonTemplateKey: 'freshness_opportunity.requested',
        reasonParams: {},
        limitedIntelligence: false,
        rulesVersion: 'test',
      },
      NOW,
    )
    const topic = await insertTopic(
      db,
      scope,
      {
        opportunityId: rewriteWork.id,
        title: 'Best trail shoes for wide feet',
        targetKeyword: 'trail shoes wide feet',
        keywordCluster: null,
        intentClass: 'buying_guide',
        familyIds: [],
        kind: 'refresh',
        source: 'auto',
        whyLine: 'x',
        scheduledDate: '2026-09-20',
        pinned: false,
        state: 'planned',
      },
      NOW,
    )
    const rewrite = await insertArticleStub(
      db,
      scope,
      {
        topicId: topic.id,
        title: 'Best trail shoes for wide feet',
        slug: `trail-shoes-rewrite-${Math.random()}`,
        targetKeyword: 'trail shoes wide feet',
        state: 'draft',
      },
      NOW,
    )

    // Scheduled and written, but not yet out: nothing has started.
    expect(await lastArticleRefreshAt(db, scope, original)).toBeNull()

    await markArticleDelivered(db, scope, rewrite.id, 'export', NOW)

    // The cooldown is recorded against the article that was rewritten, not
    // against whatever row the pipeline produced.
    expect((await lastArticleRefreshAt(db, scope, original))?.toISOString()).toBe(NOW.toISOString())
    expect(await articleRefreshCount(db, scope, rewrite.id)).toBe(0)
  })

  it('records nothing when the published article was new coverage rather than a rewrite', async () => {
    const scope = accountScope(accountId)
    const articleId = await publishedArticle(accountId, { state: 'draft' })
    await markArticleDelivered(db, scope, articleId, 'export', NOW)
    expect(await articleRefreshCount(db, scope, articleId)).toBe(0)
  })
})
