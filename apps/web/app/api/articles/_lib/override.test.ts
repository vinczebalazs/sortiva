import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { okSchema } from '@sortiva/core'
import {
  accountScope,
  articlesAwaitingReview,
  articlesReadyForDelivery,
  findArticleById,
  gateDecisionsForCalibration,
  insertGateDecision,
  markArticleInReview,
  markArticleRejectedByGate,
} from '@sortiva/db'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { withAccount } from '../../auth/_lib/session'
import { makeOverridePublishHandler } from './override'

/**
 * "Publish anyway": the button a merchant presses when they disagree with us,
 * driven end to end through the real session wrapper, the real handler, the
 * real repositories and a real Postgres.
 *
 * The button existed on the screen for the whole build with nothing at the
 * address it posts to, so a merchant pressed it and nothing at all happened.
 * Nothing here is mocked, because a mocked request is exactly the failure this
 * card exists to remove.
 *
 * The assertion that matters most is the refusal. An override endpoint that
 * publishes whatever it is handed is worse than none: it would let a button
 * press take a draft nobody graded, or somebody else's article, and clear it
 * to go out on a merchant's shop.
 */

describe('the route exists where the screen posts to it', () => {
  it('serves POST /api/articles/{articleId}/publish-anyway', async () => {
    const route = await import('../[articleId]/publish-anyway/route')
    expect(typeof route.POST).toBe('function')
    expect(route.dynamic).toBe('force-dynamic')
  })
})

const available = await databaseAvailable()
const NOW = new Date('2026-09-07T08:00:00.000Z')

describe.skipIf(!available)('publishing past the quality bar', () => {
  let harness: TestDb
  let mine: string
  let theirs: string
  let topicId: string
  let articleId: string

  beforeAll(async () => {
    harness = await setupTestDb('web_article_override')
  }, 60_000)

  afterAll(async () => {
    await harness?.close()
  })

  async function anArticle(accountId: string, slug: string) {
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
       VALUES ($1,$2,$3,'buying_guide','auto','2026-10-01')
       RETURNING id`,
      [accountId, opportunity[0]!.id, slug],
    )
    const { rows: article } = await harness.pool.query<{ id: string }>(
      'INSERT INTO articles (account_id, topic_id, title, slug) VALUES ($1,$2,$3,$4) RETURNING id',
      [accountId, topic[0]!.id, slug, slug],
    )
    return { topicId: topic[0]!.id, articleId: article[0]!.id }
  }

  /** The judge's refusal, recorded exactly as Gate 3 records it. */
  async function recordRejection(accountId: string, topic: string) {
    await insertGateDecision(harness.db, accountScope(accountId), {
      topicId: topic,
      gate: 3,
      rulesVersion: 'rules-test-v1',
      outcome: 'rejected_after_repair',
      scoresJson: {
        scores: { informationGain: 2, factualGrounding: 4 },
        justifications: { informationGain: 'Says nothing a product page does not.' },
        failed_criteria: ['informationGain'],
      },
      reasonUserFacing: 'gate3.below_quality_bar',
      promptVersion: 'judge.v1',
      modelId: 'claude-test',
    })
  }

  beforeEach(async () => {
    await truncateAll(harness.pool)
    mine = await insertAccount(harness.pool, 'override-route@example.com')
    theirs = await insertAccount(harness.pool, 'other-override@example.com')
    for (const account of [mine, theirs]) {
      await harness.pool.query(
        'INSERT INTO subscriptions (account_id, stripe_subscription_id, price_id, status) VALUES ($1,$2,$3,$4)',
        [account, `sub_${account}`, 'price_test', 'active'],
      )
    }
    const seeded = await anArticle(mine, 'held-back-guide')
    topicId = seeded.topicId
    articleId = seeded.articleId
  })

  const override = (
    accountId: string | null,
    id: string,
    body: unknown = { acknowledgedCriteria: ['informationGain'] },
  ) =>
    withAccount(
      makeOverridePublishHandler({ db: harness.db, now: () => NOW }),
      async () => accountId,
    )(
      new Request(`http://localhost/api/articles/${id}/publish-anyway`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ articleId: id }) },
    )

  const held = async () => {
    await recordRejection(mine, topicId)
    await markArticleRejectedByGate(harness.db, accountScope(mine), articleId)
  }

  // ── The refusal ───────────────────────────────────────────────────────────

  it('refuses an article the quality bar never held back, and changes nothing about it', async () => {
    const response = await override(mine, articleId)

    expect(response.status).toBe(409)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('article_not_rejected')

    const after = await findArticleById(harness.db, accountScope(mine), articleId)
    expect(after?.state).toBe('draft')
    expect(after?.publishedViaOverride).toBe(false)
    // Nothing was written to the audit trail either: no decision was overruled.
    const { rows } = await harness.pool.query('SELECT id FROM gate_decisions WHERE topic_id = $1', [topicId])
    expect(rows).toHaveLength(0)
  })

  it('refuses an article that has already gone out, and says so distinctly', async () => {
    await harness.pool.query("UPDATE articles SET state = 'published' WHERE id = $1", [articleId])
    const response = await override(mine, articleId)

    expect(response.status).toBe(409)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'article_already_published',
    )
  })

  it('refuses an article that is waiting for review rather than held back', async () => {
    await markArticleInReview(harness.db, accountScope(mine), articleId)
    const response = await override(mine, articleId)
    expect(response.status).toBe(409)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('article_not_rejected')
  })

  it("refuses another store's article exactly as one that never existed", async () => {
    const theirArticle = await anArticle(theirs, 'their-held-back-guide')
    await recordRejection(theirs, theirArticle.topicId)
    await markArticleRejectedByGate(harness.db, accountScope(theirs), theirArticle.articleId)

    expect((await override(mine, theirArticle.articleId)).status).toBe(404)
    expect(
      (await findArticleById(harness.db, accountScope(theirs), theirArticle.articleId))?.state,
    ).toBe('rejected')
  })

  it('refuses a press that names nothing it is overruling', async () => {
    await held()
    // The confirmation dialog exists so the merchant is told what they are
    // publishing past; a request that names nothing did not come from it.
    expect((await override(mine, articleId, { acknowledgedCriteria: [] })).status).toBe(422)
    expect((await override(mine, articleId, {})).status).toBe(422)
    expect((await findArticleById(harness.db, accountScope(mine), articleId))?.state).toBe('rejected')
  })

  it('refuses an unsigned-in caller', async () => {
    await held()
    expect((await override(null, articleId)).status).toBe(401)
  })

  it('refuses a store whose subscription has lapsed, without touching the article', async () => {
    await held()
    await harness.pool.query("UPDATE subscriptions SET status = 'canceled' WHERE account_id = $1", [mine])

    const response = await override(mine, articleId)
    expect(response.status).toBe(402)
    expect((await findArticleById(harness.db, accountScope(mine), articleId))?.state).toBe('rejected')
  })

  // ── The override itself ───────────────────────────────────────────────────

  it('clears the held-back article to go out and marks it for life', async () => {
    await held()
    const response = await override(mine, articleId)

    expect(response.status).toBe(200)
    okSchema.parse(await response.json())

    const after = await findArticleById(harness.db, accountScope(mine), articleId)
    expect(after?.publishedViaOverride).toBe(true)
    expect(after?.state).toBe('cleared_to_deliver')
  })

  it('hands the article to the publishing hour, and never to draft review', async () => {
    await held()
    await override(mine, articleId)
    const scope = accountScope(mine)

    expect((await articlesReadyForDelivery(harness.db, scope)).map((a) => a.id)).toEqual([articleId])
    // A merchant who has just overruled the quality bar has already made the
    // decision review exists to ask for.
    expect(await articlesAwaitingReview(harness.db, scope)).toEqual([])
    expect(await markArticleInReview(harness.db, scope, articleId)).toBeUndefined()
  })

  it('logs the override, naming the criteria the gate itself recorded', async () => {
    await held()
    await override(mine, articleId, { acknowledgedCriteria: ['languageQuality'] })

    const { rows } = await harness.pool.query<{ outcome: string; scores_json: Record<string, unknown> }>(
      "SELECT outcome, scores_json FROM gate_decisions WHERE topic_id = $1 AND outcome = 'overridden'",
      [topicId],
    )
    expect(rows).toHaveLength(1)
    // The gate's own record of what failed, not the browser's account of it —
    // both are kept, and they are kept apart.
    expect(rows[0]!.scores_json.failedCriteria).toEqual(['informationGain'])
    expect(rows[0]!.scores_json.acknowledged_criteria).toEqual(['languageQuality'])
    expect(rows[0]!.scores_json.overriddenAt).toBe(NOW.toISOString())
  })

  it('keeps the overridden article out of the data the quality bar is tuned on', async () => {
    await held()
    expect(await gateDecisionsForCalibration(harness.db, accountScope(mine))).toHaveLength(1)

    await override(mine, articleId)

    expect(await gateDecisionsForCalibration(harness.db, accountScope(mine))).toEqual([])
  })

  it('a second press changes nothing and says the draft is no longer held back', async () => {
    await held()
    expect((await override(mine, articleId)).status).toBe(200)

    const response = await override(mine, articleId)
    expect(response.status).toBe(409)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('article_not_rejected')

    const { rows } = await harness.pool.query(
      "SELECT id FROM gate_decisions WHERE topic_id = $1 AND outcome = 'overridden'",
      [topicId],
    )
    expect(rows).toHaveLength(1)
  })
})
