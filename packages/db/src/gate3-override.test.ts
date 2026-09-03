import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { accountScope } from './scope'
import type { Db } from './client'
import {
  findArticleById,
  gateDecisionsForCalibration,
  insertGateDecision,
  markArticleOverridden,
  markArticleRejectedByGate,
} from './repositories'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from './testing'

/**
 * "Publish anyway", and the price of it.
 *
 * A merchant can publish an article we turned down — it is their site. What
 * follows is invariant 12: the article is flagged for the rest of its life,
 * and the flag keeps it out of the data we tune the quality bar against. An
 * article we said was not good enough cannot be evidence about whether our
 * judgement was right, and a store that overrode everything would otherwise
 * loosen the bar for every other store.
 */

const available = await databaseAvailable()

describe.skipIf(!available)('the override path and the calibration exclusion', () => {
  let ctx: TestDb
  let pool: pg.Pool
  let db: Db
  let accountId: string

  beforeAll(async () => {
    ctx = await setupTestDb('gate3_override')
    pool = ctx.pool
    db = ctx.db as unknown as Db
  }, 60_000)

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(pool)
    accountId = await insertAccount(pool, 'override@example.com')
  })

  /** An article and the topic it came from, both real rows — the chain the audit trail needs. */
  async function anArticle(slug: string): Promise<{ topicId: string; articleId: string }> {
    const { rows: opportunity } = await pool.query<{ id: string }>(
      `INSERT INTO opportunities
         (account_id, signal_type, entity_type, entity_ref, evidence_json, impact,
          impact_score, confidence, reason_template_key, recommended_action, rules_version)
       VALUES ($1,'uncovered_commercial_query','query_cluster',$2,'[]'::jsonb,'high',
          80, 70, 'uncovered_commercial_query.default', 'create', 'abc123')
       RETURNING id`,
      [accountId, `cluster:${slug}`],
    )
    const { rows: topic } = await pool.query<{ id: string }>(
      `INSERT INTO topics (account_id, opportunity_id, title, intent_class, source, scheduled_date)
       VALUES ($1,$2,$3,'buying_guide','auto','2026-10-01')
       RETURNING id`,
      [accountId, opportunity[0]!.id, slug],
    )
    const { rows: article } = await pool.query<{ id: string }>(
      `INSERT INTO articles (account_id, topic_id, title, slug)
       VALUES ($1,$2,$3,$4)
       RETURNING id`,
      [accountId, topic[0]!.id, slug, slug],
    )
    return { topicId: topic[0]!.id, articleId: article[0]!.id }
  }

  it('flags the article and returns it to the ordinary delivery path', async () => {
    const scope = accountScope(accountId)
    const { articleId } = await anArticle('overridden-guide')

    await markArticleRejectedByGate(db, scope, articleId)
    expect((await findArticleById(db, scope, articleId))?.state).toBe('rejected')

    const overridden = await markArticleOverridden(db, scope, articleId)
    expect(overridden?.publishedViaOverride).toBe(true)
    // Back to `draft`: the merchant has already given the deliberate
    // confirmation, so publishing picks it up exactly as it would a draft that
    // passed.
    expect(overridden?.state).toBe('draft')
  })

  it('refuses to override an article the gate never rejected', async () => {
    const scope = accountScope(accountId)
    const { articleId } = await anArticle('never-rejected')

    // Guarded to `rejected` — overriding anything else is overriding a
    // decision that was never made. A zero-row result, not a silent success.
    expect(await markArticleOverridden(db, scope, articleId)).toBeUndefined()
    expect((await findArticleById(db, scope, articleId))?.publishedViaOverride).toBe(false)
  })

  it('leaves the overridden article’s gate decision out of the calibration query', async () => {
    const scope = accountScope(accountId)
    const kept = await anArticle('kept-in-calibration')
    const overridden = await anArticle('excluded-from-calibration')

    for (const article of [kept, overridden]) {
      await insertGateDecision(db, scope, {
        topicId: article.topicId,
        gate: 3,
        outcome: 'rejected_after_repair',
        scoresJson: { scores: { informationGain: 2 } },
        reasonUserFacing: 'gate3.below_quality_bar',
        promptVersion: 'judge.v1',
        modelId: 'claude-sonnet-5',
      })
    }

    // Both decisions are in the table before the override happens.
    expect(await gateDecisionsForCalibration(db, scope)).toHaveLength(2)

    await markArticleRejectedByGate(db, scope, overridden.articleId)
    await markArticleOverridden(db, scope, overridden.articleId)

    const calibration = await gateDecisionsForCalibration(db, scope)
    expect(calibration).toHaveLength(1)
    expect(calibration[0]!.topicId).toBe(kept.topicId)
    expect(calibration.some((row) => row.topicId === overridden.topicId)).toBe(false)
  })

  it('keeps the prompt and model on a gate 3 decision, so a score can be attributed later', async () => {
    const scope = accountScope(accountId)
    const { topicId } = await anArticle('attributable')
    await insertGateDecision(db, scope, {
      topicId,
      gate: 3,
      outcome: 'passed',
      scoresJson: { scores: { informationGain: 4 } },
      reasonUserFacing: null,
      promptVersion: 'judge.v1',
      modelId: 'claude-sonnet-5',
    })

    const [row] = await gateDecisionsForCalibration(db, scope)
    expect(row?.promptVersion).toBe('judge.v1')
    expect(row?.modelId).toBe('claude-sonnet-5')
  })
})
