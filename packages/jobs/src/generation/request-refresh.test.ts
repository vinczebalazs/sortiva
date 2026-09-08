import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { and, eq } from 'drizzle-orm'
import {
  accountScope,
  insertArticleStub,
  insertMinimalOpportunity,
  insertTopic,
  listTopicsInRange,
  recordArticleRefresh,
  schema,
  type Db
} from '@sortiva/db'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb, nextFixtureDay } from '@sortiva/db/testing'
import { rules } from '@sortiva/rules'
import { DbOpportunitySource } from '../scan/opportunity-source'
import { replenishCalendarForAccount } from './replenish'
import { requestArticleRefresh } from './request-refresh'

/**
 * The refresh pool, against a real database.
 *
 * The point of these is the join, not the arithmetic: that a request for one
 * of our own articles becomes a piece of work the merchant can see, that it
 * reaches the calendar through the ordinary replenishment pass rather than a
 * private route of its own, and that the cooldown actually refuses a press.
 */

const available = await databaseAvailable()
const NOW = new Date('2026-09-07T08:00:00.000Z')
const TODAY = '2026-09-07'

describe.skipIf(!available)('the refresh pool', () => {
  let ctx: TestDb
  let db: Db
  let accountId: string

  beforeAll(async () => {
    ctx = await setupTestDb('generation_request_refresh')
    db = ctx.db as unknown as Db
  }, 60_000)

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(ctx.pool)
    accountId = await insertAccount(ctx.pool, 'refresh-pool@example.com')
  })

  let seq = 0

  async function publishedArticle(
    over: { readonly override?: boolean; readonly state?: 'published' | 'draft' } = {},
  ): Promise<string> {
    seq += 1
    const scope = accountScope(accountId)
    const opportunity = await insertMinimalOpportunity(
      db,
      scope,
      {
        signalType: 'uncovered_commercial_query',
        entityType: 'query_cluster',
        entityRef: `seed-${seq}`,
        evidenceJson: [],
        recommendedAction: 'create',
        status: 'completed',
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
        title: `Best trail shoes ${seq}`,
        targetKeyword: `trail shoes ${seq}`,
        keywordCluster: null,
        intentClass: 'buying_guide',
        familyIds: [],
        kind: 'new',
        source: 'auto',
        whyLine: 'x',
        scheduledDate: nextFixtureDay('2026-01-01'),
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
        title: `Best trail shoes ${seq}`,
        slug: `trail-shoes-${seq}`,
        targetKeyword: `trail shoes ${seq}`,
        state: 'draft',
      },
      NOW,
    )
    await db.execute(
      sql`update articles set state = ${over.state ?? 'published'}, published_via_override = ${over.override ?? false} where id = ${article.id}`,
    )
    return article.id
  }

  const deps = () => ({ db, now: () => NOW })

  it('turns an improve-this-page suggestion on one of our articles into work waiting for a calendar day', async () => {
    const articleId = await publishedArticle()

    const result = await requestArticleRefresh(deps(), {
      accountId,
      articleId,
      source: 'optimize_on_our_own_article',
    })
    expect(result).toMatchObject({ ok: true, created: true })

    const pool = await new DbOpportunitySource(db).acceptedContentOpportunities(accountId)
    expect(pool).toHaveLength(1)
    expect(pool[0]).toMatchObject({ recommendedAction: 'REFRESH' })
  })

  it('reaches the calendar only through the ordinary replenishment pass', async () => {
    const articleId = await publishedArticle()
    await requestArticleRefresh(deps(), { accountId, articleId, source: 'merchant_request' })

    // Nothing is on the calendar yet: admitting a request writes one piece of
    // work and stops.
    expect(await listTopicsInRange(db, accountScope(accountId), TODAY, '2027-12-31')).toHaveLength(0)

    const outcome = await replenishCalendarForAccount(
      { db, pool: ctx.pool, opportunities: new DbOpportunitySource(db), now: () => NOW },
      accountId,
    )
    expect(outcome.status).toBe('filled')

    const topics = await listTopicsInRange(db, accountScope(accountId), TODAY, '2027-12-31')
    expect(topics).toHaveLength(1)
    expect(topics[0]).toMatchObject({ kind: 'refresh', state: 'planned' })
    // Never today: the day's dequeue may already have run.
    expect(topics[0]!.scheduledDate > TODAY).toBe(true)
  })

  it('refuses an article refreshed 30 days ago, and admits the same one after the cooldown', async () => {
    const articleId = await publishedArticle()
    const scope = accountScope(accountId)
    await recordArticleRefresh(db, scope, articleId, new Date('2026-08-08T08:00:00.000Z'))

    expect(
      await requestArticleRefresh(deps(), { accountId, articleId, source: 'merchant_request' }),
    ).toEqual({ ok: false, reason: 'not_eligible', blockers: ['within_cooldown'] })

    const cooldown = rules().defaults.learning.refresh.cooldown_days
    const past = new Date(NOW.getTime() + (cooldown + 1) * 86400000)
    expect(
      await requestArticleRefresh({ db, now: () => past }, {
        accountId,
        articleId,
        source: 'merchant_request',
      }),
    ).toMatchObject({ ok: true })
  })

  it('refuses an article the merchant published over our quality objection', async () => {
    const articleId = await publishedArticle({ override: true })
    expect(
      await requestArticleRefresh(deps(), { accountId, articleId, source: 'merchant_request' }),
    ).toEqual({ ok: false, reason: 'not_eligible', blockers: ['published_via_override'] })
  })

  it('refuses an article already queued for a factual repair', async () => {
    const articleId = await publishedArticle()
    await insertMinimalOpportunity(
      db,
      accountScope(accountId),
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
    expect(
      await requestArticleRefresh(deps(), { accountId, articleId, source: 'merchant_request' }),
    ).toEqual({ ok: false, reason: 'not_eligible', blockers: ['repair_pending'] })
  })

  it('refuses a draft, which has nothing live to rewrite', async () => {
    const articleId = await publishedArticle({ state: 'draft' })
    expect(
      await requestArticleRefresh(deps(), { accountId, articleId, source: 'merchant_request' }),
    ).toEqual({ ok: false, reason: 'not_eligible', blockers: ['not_published'] })
  })

  it('says nothing about an article that is not this store’s', async () => {
    const otherAccountId = await insertAccount(ctx.pool, 'somebody-else@example.com')
    const theirs = await publishedArticle()
    expect(
      await requestArticleRefresh(deps(), {
        accountId: otherAccountId,
        articleId: theirs,
        source: 'merchant_request',
      }),
    ).toEqual({ ok: false, reason: 'article_not_found' })
  })

  it('makes a second press the same piece of work, not a second rewrite', async () => {
    const articleId = await publishedArticle()
    const first = await requestArticleRefresh(deps(), { accountId, articleId, source: 'merchant_request' })
    const second = await requestArticleRefresh(deps(), { accountId, articleId, source: 'merchant_request' })

    expect(first).toMatchObject({ ok: true, created: true })
    expect(second).toMatchObject({ ok: true, created: false })
    if (!first.ok || !second.ok) throw new Error('both presses should have been admitted')
    expect(second.opportunityId).toBe(first.opportunityId)

    const pool = await new DbOpportunitySource(db).acceptedContentOpportunities(accountId)
    expect(pool).toHaveLength(1)
  })

  // ── An operator moving one of these numbers for one store ─────────────────
  //
  // The refresh pool judges a merchant's press against thresholds an operator
  // can move for a single store without a deploy, and the piece of work it
  // writes records which numbers judged it. Both halves matter: the decision
  // has to change, and the record has to say it was made under a moved number
  // rather than under the ones in the repo.

  async function setOverride(forAccountId: string, key: string, value: unknown): Promise<void> {
    await db.insert(schema.rulesOverrides).values({
      accountId: forAccountId,
      locale: null,
      pageType: null,
      key,
      value,
      updatedBy: 'test-operator',
      updatedAt: NOW,
    })
  }

  async function stampedVersion(articleId: string): Promise<string> {
    const [row] = await db
      .select({ rulesVersion: schema.opportunities.rulesVersion })
      .from(schema.opportunities)
      .where(
        and(
          eq(schema.opportunities.accountId, accountId),
          eq(schema.opportunities.entityType, 'article'),
          eq(schema.opportunities.entityRef, articleId),
        ),
      )
    if (!row) throw new Error('no piece of work was written for that article')
    return row.rulesVersion
  }

  it('admits a press the repo numbers refuse, once the cooldown is moved for that store', async () => {
    const articleId = await publishedArticle()
    await recordArticleRefresh(db, accountScope(accountId), articleId, new Date('2026-08-08T08:00:00.000Z'))

    // 30 days ago, against a cooldown of 60: refused everywhere by default.
    expect(
      await requestArticleRefresh(deps(), { accountId, articleId, source: 'merchant_request' }),
    ).toEqual({ ok: false, reason: 'not_eligible', blockers: ['within_cooldown'] })

    await setOverride(accountId, 'learning.refresh.cooldown_days', 7)

    expect(
      await requestArticleRefresh(deps(), { accountId, articleId, source: 'merchant_request' }),
    ).toMatchObject({ ok: true, created: true })
    // The record says it was judged by a moved number, not by the repo file.
    expect(await stampedVersion(articleId)).toMatch(
      new RegExp(`^${rules().rulesVersion}\\+ov\\.[0-9a-f]{16}$`),
    )
  })

  it('leaves a store with no row of its own judged and stamped exactly as before', async () => {
    const somebodyElse = await insertAccount(ctx.pool, 'not-this-store@example.com')
    await setOverride(somebodyElse, 'learning.refresh.cooldown_days', 7)

    const articleId = await publishedArticle()
    await recordArticleRefresh(db, accountScope(accountId), articleId, new Date('2026-08-08T08:00:00.000Z'))

    expect(
      await requestArticleRefresh(deps(), { accountId, articleId, source: 'merchant_request' }),
    ).toEqual({ ok: false, reason: 'not_eligible', blockers: ['within_cooldown'] })

    const fresh = await publishedArticle()
    expect(
      await requestArticleRefresh(deps(), { accountId, articleId: fresh, source: 'merchant_request' }),
    ).toMatchObject({ ok: true })
    expect(await stampedVersion(fresh)).toBe(rules().rulesVersion)
  })
})
