import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { okSchema } from '@sortiva/core'
import { accountScope, insertArticleStub, insertMinimalOpportunity, insertTopic } from '@sortiva/db'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { withAccount } from '../../auth/_lib/session'
import { makeApproveArticleHandler, makeDiscardArticleHandler, type RouteCtx } from './review'

/**
 * The two review routes. Everything they can do is here: keep it, or throw it
 * away. `packages/core/src/generation/no-editor.test.ts` is what fails if a
 * third one ever appears.
 */

const available = await databaseAvailable()
const NOW = new Date('2026-09-03T08:00:00.000Z')

describe.skipIf(!available)('article review routes', () => {
  let harness: TestDb
  let accountId: string

  beforeAll(async () => {
    harness = await setupTestDb('web_article_review')
  })

  afterAll(async () => {
    await harness.close()
  })

  beforeEach(async () => {
    await truncateAll(harness.pool)
    accountId = await insertAccount(harness.pool, 'article-review@example.com')
  })

  async function seedArticle(state: 'draft' | 'in_review' | 'published') {
    const scope = accountScope(accountId)
    const opportunity = await insertMinimalOpportunity(
      harness.db,
      scope,
      {
        signalType: 'uncovered_commercial_query',
        entityType: 'query_cluster',
        entityRef: `q-${state}`,
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
        scheduledDate: '2026-09-03',
        pinned: false,
        state: state === 'in_review' ? 'in_review' : 'generating',
      },
      NOW,
    )
    return insertArticleStub(
      harness.db,
      scope,
      { topicId: topic.id, title: 'Best water bottles', slug: `best-${state}`, targetKeyword: 'best water bottles', state },
      NOW,
    )
  }

  const post = (handler: ReturnType<typeof withAccount<RouteCtx>>, articleId: string) =>
    handler(new Request('http://localhost/x', { method: 'POST' }), {
      params: Promise.resolve({ articleId }),
    })

  const approve = () =>
    withAccount(makeApproveArticleHandler({ db: harness.db, now: () => NOW }), async () => accountId)
  const discard = () =>
    withAccount(makeDiscardArticleHandler({ db: harness.db, now: () => NOW }), async () => accountId)

  it('approves a draft that was waiting', async () => {
    const article = await seedArticle('in_review')
    const response = await post(approve(), article.id)
    expect(response.status).toBe(200)
    expect(okSchema.parse(await response.json())).toEqual({ ok: true })
  })

  it('discards a draft that was waiting', async () => {
    const article = await seedArticle('in_review')
    const response = await post(discard(), article.id)
    expect(response.status).toBe(200)
    expect(okSchema.parse(await response.json())).toEqual({ ok: true })
  })

  it('409s with the frozen conflict code when nobody was asked', async () => {
    const article = await seedArticle('draft')
    const response = await post(approve(), article.id)
    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('article_not_in_review')
  })

  it('409s distinctly on an article that has already published', async () => {
    const article = await seedArticle('published')
    const response = await post(discard(), article.id)
    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('article_already_published')
  })

  it('404s an article that does not exist', async () => {
    const response = await post(approve(), '00000000-0000-4000-8000-000000000000')
    expect(response.status).toBe(404)
  })

  it('401s without a session', async () => {
    const article = await seedArticle('in_review')
    const handler = withAccount(makeApproveArticleHandler({ db: harness.db, now: () => NOW }), async () => null)
    const response = await post(handler, article.id)
    expect(response.status).toBe(401)
  })
})
