import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { accountScope } from './scope'
import { markArticleDelivered } from './repositories/delivery'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from './testing'

/**
 * The calendar day an article publishes on, and the one case where it must not
 * move.
 *
 * `published` had no producer at all until this card, so a topic stayed at
 * whatever the writing left it — which is how a refusal the merchant overruled
 * went on being counted as held back weeks later.
 */

const available = await databaseAvailable()

describe.skipIf(!available)('a topic whose article goes out', () => {
  let ctx: TestDb
  let pool: pg.Pool
  let accountId: string

  beforeAll(async () => {
    ctx = await setupTestDb('topic_publication')
    pool = ctx.pool
  })

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(pool)
    accountId = await insertAccount(pool, 'topic-publication@example.com')
  })

  /** A topic in a given state with a deliverable article on it. */
  async function plant(state: string): Promise<{ topicId: string; articleId: string }> {
    const { rows: opportunity } = await pool.query<{ id: string }>(
      `INSERT INTO opportunities
         (account_id, signal_type, entity_type, entity_ref, evidence_json, impact,
          impact_score, confidence, reason_template_key, recommended_action, rules_version)
       VALUES ($1,'uncovered_commercial_query','query_cluster','cluster:x','[]'::jsonb,'high',
          80, 70, 'uncovered_commercial_query.create', 'create', 'abc123')
       RETURNING id`,
      [accountId],
    )
    const { rows: topic } = await pool.query<{ id: string }>(
      `INSERT INTO topics (account_id, opportunity_id, title, intent_class, source, scheduled_date, state)
       VALUES ($1,$2,'A topic','buying_guide','auto','2026-08-10',$3) RETURNING id`,
      [accountId, opportunity[0]!.id, state],
    )
    const { rows: article } = await pool.query<{ id: string }>(
      `INSERT INTO articles (account_id, topic_id, title, slug, state)
       VALUES ($1,$2,'A topic','a-topic','cleared_to_deliver') RETURNING id`,
      [accountId, topic[0]!.id],
    )
    return { topicId: topic[0]!.id, articleId: article[0]!.id }
  }

  const stateOf = async (topicId: string) =>
    (await pool.query<{ state: string }>('SELECT state FROM topics WHERE id = $1', [topicId]))
      .rows[0]!.state

  it('follows its article out of a quality refusal the merchant overruled', async () => {
    const { topicId, articleId } = await plant('rejected_by_gate')

    const result = await markArticleDelivered(ctx.db, accountScope(accountId), articleId, 'export')

    expect(result?.publishedTopic?.state).toBe('published')
    expect(await stateOf(topicId)).toBe('published')
  })

  it('follows it out of review on the ordinary path too', async () => {
    const { topicId, articleId } = await plant('in_review')
    await markArticleDelivered(ctx.db, accountScope(accountId), articleId, 'export')
    expect(await stateOf(topicId)).toBe('published')
  })

  it('never relabels a vetoed day as published, and says it did not', async () => {
    const { topicId, articleId } = await plant('vetoed')

    const result = await markArticleDelivered(ctx.db, accountScope(accountId), articleId, 'export')

    // The article got out for a topic the merchant cancelled. Something failed
    // to stop it, and quietly writing "published" over the veto would hide
    // that. The article's own state moves; the day keeps saying what happened.
    expect(result?.article.state).toBe('published')
    expect(result?.publishedTopic).toBeUndefined()
    expect(await stateOf(topicId)).toBe('vetoed')
  })

  it('cannot reach another account’s calendar', async () => {
    const other = await insertAccount(pool, 'other@example.com')
    const { topicId, articleId } = await plant('in_review')

    expect(
      await markArticleDelivered(ctx.db, accountScope(other), articleId, 'export'),
    ).toBeUndefined()
    expect(await stateOf(topicId)).toBe('in_review')
    // Stated plainly because it is what this proves and what it does not: the
    // delivery refuses on the *article*'s scope, so the topic write is never
    // reached from here. The account scope on that write is a second lock on a
    // door this test finds already shut — kept because every repository write
    // carries one, not because this case would notice it missing.
  })
})
