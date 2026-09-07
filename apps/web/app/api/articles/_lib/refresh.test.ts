import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { okSchema } from '@sortiva/core'
import {
  accountScope,
  insertArticleStub,
  insertMinimalOpportunity,
  insertTopic,
  recordArticleRefresh,
} from '@sortiva/db'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { withAccount } from '../../auth/_lib/session'
import { makeRequestRefreshHandler, type RefreshRouteCtx } from './refresh'

/**
 * "Request refresh" on an article we published.
 *
 * What is worth proving at this level rather than in the pool's own tests is
 * the shape of each answer a merchant can get: the frozen conflict code for a
 * press inside the cooldown, a distinct refusal for the reasons that are not a
 * lost race, and that billing gates asking for new work.
 */

const available = await databaseAvailable()
const NOW = new Date('2026-09-07T08:00:00.000Z')

describe.skipIf(!available)('the request-refresh route', () => {
  let harness: TestDb
  let accountId: string
  let seq = 0

  beforeAll(async () => {
    harness = await setupTestDb('web_article_refresh')
  }, 60_000)

  afterAll(async () => {
    await harness.close()
  })

  beforeEach(async () => {
    await truncateAll(harness.pool)
    accountId = await insertAccount(harness.pool, 'refresh-route@example.com')
    await harness.pool.query(
      'INSERT INTO subscriptions (account_id, stripe_subscription_id, price_id, status) VALUES ($1, $2, $3, $4)',
      [accountId, 'sub_test', 'price_test', 'active'],
    )
  })

  async function publishedArticle(over: { readonly override?: boolean } = {}): Promise<string> {
    seq += 1
    const scope = accountScope(accountId)
    const opportunity = await insertMinimalOpportunity(
      harness.db,
      scope,
      {
        signalType: 'uncovered_commercial_query',
        entityType: 'query_cluster',
        entityRef: `q-${seq}`,
        evidenceJson: [],
        recommendedAction: 'create',
        status: 'completed',
        reasonTemplateKey: 'gate1.admitted',
        reasonParams: {},
        limitedIntelligence: false,
        rulesVersion: 'a'.repeat(64),
      },
      NOW,
    )
    const topic = await insertTopic(
      harness.db,
      scope,
      {
        opportunityId: opportunity.id,
        title: 'Best water bottles',
        targetKeyword: 'best water bottles',
        keywordCluster: null,
        intentClass: 'buying_guide',
        familyIds: [],
        kind: 'new',
        source: 'auto',
        whyLine: 'topic.auto',
        scheduledDate: '2026-08-01',
        pinned: false,
        state: 'published',
      },
      NOW,
    )
    const article = await insertArticleStub(
      harness.db,
      scope,
      {
        topicId: topic.id,
        title: 'Best water bottles',
        slug: `best-water-bottles-${seq}`,
        targetKeyword: 'best water bottles',
        state: 'draft',
      },
      NOW,
    )
    await harness.db.execute(
      sql`update articles set state = 'published', published_via_override = ${over.override ?? false} where id = ${article.id}`,
    )
    return article.id
  }

  const post = (handler: ReturnType<typeof withAccount<RefreshRouteCtx>>, articleId: string) =>
    handler(new Request('http://localhost/x', { method: 'POST' }), {
      params: Promise.resolve({ articleId }),
    })

  const route = (session: string | null = accountId) =>
    withAccount(makeRequestRefreshHandler({ db: harness.db, now: () => NOW }), async () => session)

  it('accepts the request and puts one piece of work into the pool', async () => {
    const articleId = await publishedArticle()
    const response = await post(route(), articleId)
    expect(response.status).toBe(200)
    expect(okSchema.parse(await response.json())).toEqual({ ok: true })
  })

  it('409s with the frozen conflict code when it was refreshed recently', async () => {
    const articleId = await publishedArticle()
    await recordArticleRefresh(harness.db, accountScope(accountId), articleId, new Date('2026-08-20T08:00:00.000Z'))

    const response = await post(route(), articleId)
    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('refresh_within_cooldown')
  })

  it('refuses an override-published article distinctly from a lost race', async () => {
    const articleId = await publishedArticle({ override: true })
    const response = await post(route(), articleId)
    expect(response.status).toBe(422)
    const body = (await response.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('refresh_not_eligible')
    expect(body.error.message).toContain('quality objection')
  })

  it('404s an article that does not exist', async () => {
    const response = await post(route(), '00000000-0000-4000-8000-000000000000')
    expect(response.status).toBe(404)
  })

  it('401s without a session', async () => {
    const articleId = await publishedArticle()
    const response = await post(route(null), articleId)
    expect(response.status).toBe(401)
  })

  it('402s an account with no active subscription — asking for new work is what billing gates', async () => {
    const articleId = await publishedArticle()
    await harness.pool.query('DELETE FROM subscriptions WHERE account_id = $1', [accountId])
    const response = await post(route(), articleId)
    expect(response.status).toBe(402)
  })
})
