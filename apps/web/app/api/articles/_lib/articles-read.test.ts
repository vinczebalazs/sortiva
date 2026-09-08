import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { listArticlesResponseSchema } from '@sortiva/core'
import { accountScope, markArticleOverridden, markArticleRejectedByGate } from '@sortiva/db'
import { databaseAvailable, nextFixtureDay, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { withAccount } from '../../auth/_lib/session'
import { makeListArticlesHandler } from './library'

/**
 * The articles library, driven end to end: the real session wrapper, the real
 * handler, the real repositories, a real Postgres.
 *
 * This card exists because the screen appeared to work while its server did not
 * exist at all — the loader turns any failure into "no data", so a 404 from a
 * route nobody built renders as a store that has never had an article written.
 * Mocking the fetch here would reproduce that exactly.
 */

describe('the route exists where the screen calls it', () => {
  it('serves GET /api/articles', async () => {
    const route = await import('../route')
    expect(typeof route.GET).toBe('function')
    expect(route.dynamic).toBe('force-dynamic')
  })
})

const available = await databaseAvailable()

describe.skipIf(!available)('reading the articles library', () => {
  let harness: TestDb
  let mine: string
  let theirs: string

  beforeAll(async () => {
    harness = await setupTestDb('web_articles_read')
  }, 60_000)

  afterAll(async () => {
    await harness?.close()
  })

  /** An opportunity, a calendar day and an article — the chain an article row needs. */
  async function anArticle(
    accountId: string,
    slug: string,
    overrides: Partial<{
      state: string
      delivery: string
      publishedUrl: string | null
      publishedAt: string | null
      createdAt: string
    }> = {},
  ): Promise<{ topicId: string; articleId: string }> {
    const { rows: opportunity } = await harness.pool.query<{ id: string }>(
      `INSERT INTO opportunities
         (account_id, signal_type, entity_type, entity_ref, evidence_json, impact,
          impact_score, confidence, reason_template_key, recommended_action, rules_version)
       VALUES ($1,'uncovered_commercial_query','query_cluster',$2,'[]'::jsonb,'high',
          80, 70, 'uncovered_commercial_query.default', 'create', 'test-rules')
       RETURNING id`,
      [accountId, `cluster:${slug}`],
    )
    const { rows: topic } = await harness.pool.query<{ id: string }>(
      `INSERT INTO topics (account_id, opportunity_id, title, intent_class, source, scheduled_date)
       VALUES ($1,$2,$3,'buying_guide','auto',$4)
       RETURNING id`,
      [accountId, opportunity[0]!.id, slug, nextFixtureDay('2026-10-01')],
    )
    const { rows: article } = await harness.pool.query<{ id: string }>(
      `INSERT INTO articles
         (account_id, topic_id, title, slug, state, delivery, published_url, published_at, created_at)
       VALUES ($1,$2,$3,$4,
               COALESCE($5,'draft')::article_state,
               COALESCE($6,'export')::delivery_mode,
               $7, $8::timestamptz, COALESCE($9::timestamptz, now()))
       RETURNING id`,
      [
        accountId,
        topic[0]!.id,
        slug,
        slug,
        overrides.state ?? null,
        overrides.delivery ?? null,
        overrides.publishedUrl ?? null,
        overrides.publishedAt ?? null,
        overrides.createdAt ?? null,
      ],
    )
    return { topicId: topic[0]!.id, articleId: article[0]!.id }
  }

  beforeEach(async () => {
    await truncateAll(harness.pool)
    const { rows } = await harness.pool.query<{ id: string; email: string }>(
      "INSERT INTO accounts (email) VALUES ('mine@example.com'), ('theirs@example.com') RETURNING id, email",
    )
    mine = rows.find((row) => row.email === 'mine@example.com')!.id
    theirs = rows.find((row) => row.email === 'theirs@example.com')!.id
  })

  const list = (accountId: string | null, query = '') =>
    withAccount(
      makeListArticlesHandler({ db: harness.db }),
      async () => accountId,
    )(new Request(`http://localhost/api/articles${query}`), undefined)

  const listed = async (accountId: string, query = '') => {
    const response = await list(accountId, query)
    expect(response.status).toBe(200)
    return listArticlesResponseSchema.parse(await response.json())
  }

  it('lists the store’s own articles, newest first', async () => {
    await anArticle(mine, 'older-guide', { createdAt: '2026-08-01T00:00:00Z' })
    await anArticle(mine, 'newer-guide', { createdAt: '2026-09-01T00:00:00Z' })

    const body = await listed(mine)
    expect(body.articles.map((article) => article.title)).toEqual(['newer-guide', 'older-guide'])
    expect(body.cursor).toBeNull()
  })

  it('bites: the same read against a store with no articles is not the same answer', async () => {
    await anArticle(mine, 'the-only-one')
    const full = await listed(mine)
    expect(full.articles).toHaveLength(1)

    await harness.pool.query('DELETE FROM articles WHERE account_id = $1', [mine])

    // Still 200 and still a valid contract answer — a store that has had
    // nothing written is not an error. What must differ is the content, which
    // is exactly the difference a missing route could not produce.
    const empty = await listed(mine)
    expect(empty.articles).toEqual([])
  })

  it('reports an overridden article as a draft, with the badge that says how it got there', async () => {
    const scope = accountScope(mine)
    const { articleId } = await anArticle(mine, 'overruled')
    await markArticleRejectedByGate(harness.db, scope, articleId)
    await markArticleOverridden(harness.db, scope, articleId)

    const body = await listed(mine)
    // Storage has a sixth state meaning "a person cleared this to go out"; the
    // screens have no word for it, so it reads as a draft waiting for the
    // publishing hour and the override flag carries the rest.
    expect(body.articles[0]!.state).toBe('draft')
    expect(body.articles[0]!.publishedViaOverride).toBe(true)
  })

  it('counts the rewrites and flags a repair that actually changed something', async () => {
    const { articleId } = await anArticle(mine, 'much-loved', { state: 'published' })
    await harness.pool.query(
      "INSERT INTO refresh_log (article_id, refreshed_at) VALUES ($1, now()), ($1, now() - interval '90 days')",
      [articleId],
    )
    await harness.pool.query(
      `INSERT INTO opportunities
         (account_id, signal_type, entity_type, entity_ref, evidence_json, impact, impact_score,
          confidence, reason_template_key, recommended_action, rules_version, outcome_json)
       VALUES ($1,'broken_product_reference','article',$2,'[]'::jsonb,'high',60,60,
               'broken_product_reference.default','fix','test-rules','{"repaired":true}'::jsonb)`,
      [mine, articleId],
    )

    const body = await listed(mine)
    expect(body.articles[0]!.refreshedCount).toBe(2)
    expect(body.articles[0]!.repaired).toBe(true)
  })

  it('leaves an unrepaired article unflagged, so the badge means something', async () => {
    await anArticle(mine, 'untouched', { state: 'published' })
    const body = await listed(mine)
    expect(body.articles[0]!.repaired).toBe(false)
    expect(body.articles[0]!.refreshedCount).toBe(0)
  })

  it('has no performance to report, because nothing measures one yet', async () => {
    await anArticle(mine, 'published-long-ago', {
      state: 'published',
      publishedAt: '2026-01-01T00:00:00Z',
      publishedUrl: 'https://example.com/blogs/news/published-long-ago',
    })
    const body = await listed(mine)
    expect(body.articles[0]!.performance).toBeNull()
  })

  it('narrows to the states asked for, and to the ones waiting on the merchant', async () => {
    await anArticle(mine, 'waiting-for-review', { state: 'in_review' })
    await anArticle(mine, 'gone', { state: 'discarded' })
    await anArticle(mine, 'exported-no-address', { state: 'published', delivery: 'export' })
    await anArticle(mine, 'auto-published', {
      state: 'published',
      delivery: 'auto',
      publishedUrl: 'https://example.com/blogs/news/auto-published',
    })

    const drafts = await listed(mine, '?state=in_review')
    expect(drafts.articles.map((article) => article.title)).toEqual(['waiting-for-review'])

    const attention = await listed(mine, '?needsAttention=true')
    expect(attention.articles.map((article) => article.title).sort()).toEqual([
      'exported-no-address',
      'waiting-for-review',
    ])
  })

  it('refuses a filter it cannot read rather than answering as though there were none', async () => {
    await anArticle(mine, 'present')
    const response = await list(mine, '?state=not-a-state')
    // A list that quietly ignored the filter would look exactly like a store
    // with nothing matching it.
    expect(response.status).toBe(422)
  })

  it('never shows one store another store’s articles', async () => {
    await anArticle(theirs, 'their-secret-guide')
    const raw = await (await list(mine)).text()
    expect(raw).not.toContain('their-secret-guide')

    const theirBody = await listed(theirs)
    expect(theirBody.articles.map((article) => article.title)).toEqual(['their-secret-guide'])
  })

  it('refuses an unsigned-in caller', async () => {
    expect((await list(null)).status).toBe(401)
  })
})
