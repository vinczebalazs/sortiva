import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import {
  CHECK_VIOLATION,
  EXCLUSION_VIOLATION,
  NOT_NULL_VIOLATION,
  databaseAvailable,
  insertAccount,
  pgErrorCode,
  setupTestDb,
  truncateAll,
  type TestDb,
} from './testing'

/**
 * `T-WAVE7` — three storage changes that each close a gap between something the
 * product assumed and something the database enforced.
 *
 * Every assertion here has to run against a real Postgres, because in all three
 * cases the thing being tested is the refusal. A check constraint, an exclusion
 * constraint and a not-null column are invisible to TypeScript: nothing but a
 * server saying no proves they are there, and nothing but a test like this
 * notices when a future schema regeneration drops one. The exclusion constraint
 * doubly so — it is hand-written in migration `0013` because the schema builder
 * cannot express it, so it appears nowhere in the TypeScript schema at all.
 */

const available = await databaseAvailable()

describe.skipIf(!available)('T-WAVE7 — publish attempts, one topic a day, stamped verdicts', () => {
  let ctx: TestDb
  let pool: pg.Pool

  beforeAll(async () => {
    ctx = await setupTestDb('constraints_t_wave7')
    pool = ctx.pool
  })

  afterAll(async () => {
    await ctx.close()
  })

  beforeEach(async () => {
    await truncateAll(pool)
  })

  /** The chain a topic hangs off: nothing is scheduled that has no reason behind it. */
  async function anOpportunity(accountId: string, ref: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO opportunities
         (account_id, signal_type, entity_type, entity_ref, evidence_json, impact,
          impact_score, confidence, reason_template_key, recommended_action, rules_version)
       VALUES ($1,'uncovered_commercial_query','query_cluster',$2,'[]'::jsonb,'high',
          80, 70, 'uncovered_commercial_query.default', 'create', 'rules-test-v1')
       RETURNING id`,
      [accountId, ref],
    )
    return rows[0]!.id
  }

  async function aTopic(
    accountId: string,
    opportunityId: string,
    scheduledDate: string,
    state = 'planned',
  ): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO topics
         (account_id, opportunity_id, title, intent_class, source, scheduled_date, state)
       VALUES ($1,$2,'Best trail shoes','buying_guide','auto',$3,$4)
       RETURNING id`,
      [accountId, opportunityId, scheduledDate, state],
    )
    return rows[0]!.id
  }

  async function anArticle(accountId: string, topicId: string, slug: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO articles (account_id, topic_id, title, slug)
       VALUES ($1,$2,'Best trail shoes',$3)
       RETURNING id`,
      [accountId, topicId, slug],
    )
    return rows[0]!.id
  }

  // ── publish_attempts ───────────────────────────────────────────────────────

  describe('every publish attempt leaves a record, and a failure says what failed', () => {
    async function anAccountAndArticle(): Promise<{ accountId: string; articleId: string }> {
      const accountId = await insertAccount(pool, 'publish@example.com')
      const opportunity = await anOpportunity(accountId, 'cluster:sizing')
      const topic = await aTopic(accountId, opportunity, '2026-10-01')
      return { accountId, articleId: await anArticle(accountId, topic, 'best-trail-shoes') }
    }

    const attempt = (
      accountId: string,
      articleId: string | null,
      outcome: string,
      failureClass: string | null,
    ) =>
      pool.query(
        `INSERT INTO publish_attempts
           (account_id, article_id, article_external_id, outcome, failure_class)
         VALUES ($1,$2,'sortiva:article:1:r0',$3,$4)`,
        [accountId, articleId, outcome, failureClass],
      )

    /**
     * The row the whole table exists for. A refusal is the ordinary way a
     * publish fails and the one the claim row cannot hold, because a refusal
     * releases the claim so the next attempt can take the name.
     */
    it('stores a refusal, which is the failure nothing recorded before', async () => {
      const { accountId, articleId } = await anAccountAndArticle()
      await expect(
        attempt(accountId, articleId, 'refused', 'shopify_rate_limited'),
      ).resolves.toBeDefined()

      const { rows } = await pool.query<{ outcome: string; failure_class: string }>(
        `SELECT outcome, failure_class FROM publish_attempts WHERE account_id = $1`,
        [accountId],
      )
      expect(rows).toEqual([{ outcome: 'refused', failure_class: 'shopify_rate_limited' }])
    })

    it('stores each of the four ways an attempt ends', async () => {
      const { accountId, articleId } = await anAccountAndArticle()
      await attempt(accountId, articleId, 'succeeded', null)
      await attempt(accountId, articleId, 'refused', 'shopify_token_invalid')
      await attempt(accountId, articleId, 'uncertain', 'shop_unreachable')
      await attempt(accountId, articleId, 'abandoned', 'recovery_exhausted')

      const { rows } = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM publish_attempts WHERE account_id = $1`,
        [accountId],
      )
      expect(rows[0]!.count).toBe('4')
    })

    it('refuses an ending it has no name for', async () => {
      const { accountId, articleId } = await anAccountAndArticle()
      const rejected = await attempt(accountId, articleId, 'sort_of_worked', 'mystery').catch(
        (e) => e,
      )
      // An unknown enum label is an invalid input rather than a constraint
      // violation, so this asserts the insert was refused rather than a code.
      expect(rejected).toBeInstanceOf(Error)
    })

    /**
     * A failure with nothing naming it tells an operator that something went
     * wrong and not what — which is the difference between "the platform is
     * down" and "one merchant's token expired", and the only reason the brake
     * is worth reading during an incident.
     */
    it('refuses a failure that does not say what failed', async () => {
      const { accountId, articleId } = await anAccountAndArticle()
      const rejected = await attempt(accountId, articleId, 'refused', null).catch((e) => e)
      expect(pgErrorCode(rejected)).toBe(CHECK_VIOLATION)
    })

    it('refuses a success that claims a failure anyway', async () => {
      const { accountId, articleId } = await anAccountAndArticle()
      const rejected = await attempt(accountId, articleId, 'succeeded', 'shop_refused').catch(
        (e) => e,
      )
      expect(pgErrorCode(rejected)).toBe(CHECK_VIOLATION)
    })

    it('refuses an attempt that does not name the publication it was for', async () => {
      const { accountId, articleId } = await anAccountAndArticle()
      const rejected = await pool
        .query(
          `INSERT INTO publish_attempts (account_id, article_id, outcome, failure_class)
           VALUES ($1,$2,'refused','shop_refused')`,
          [accountId, articleId],
        )
        .catch((e) => e)
      expect(pgErrorCode(rejected)).toBe(NOT_NULL_VIOLATION)
    })

    /**
     * Deleting an article must not erase the evidence that publishing it kept
     * failing. That evidence is the one thing this table holds, and a cascade
     * here would take it away exactly when somebody is trying to work out what
     * went wrong.
     */
    it('keeps the attempt when the article it was for is deleted', async () => {
      const { accountId, articleId } = await anAccountAndArticle()
      await attempt(accountId, articleId, 'refused', 'shopify_rate_limited')
      await pool.query(`DELETE FROM articles WHERE id = $1`, [articleId])

      const { rows } = await pool.query<{ article_id: string | null; outcome: string }>(
        `SELECT article_id, outcome FROM publish_attempts WHERE account_id = $1`,
        [accountId],
      )
      expect(rows).toEqual([{ article_id: null, outcome: 'refused' }])
    })

    /** A closed account takes its own records with it — the rest of the product's deletion rule. */
    it('takes the attempts with the account', async () => {
      const { accountId, articleId } = await anAccountAndArticle()
      await attempt(accountId, articleId, 'refused', 'shopify_rate_limited')
      await pool.query(`DELETE FROM accounts WHERE id = $1`, [accountId])

      const { rows } = await pool.query(`SELECT 1 FROM publish_attempts`)
      expect(rows).toHaveLength(0)
    })
  })

  // ── one live topic per store per day ───────────────────────────────────────

  describe('the calendar holds one live topic per store per day', () => {
    /**
     * The race the constraint exists to close. Adding a topic reads the day to see
     * whether it is free and then inserts, so two requests a few milliseconds
     * apart both saw an empty day — the same check-then-insert shape the domain
     * claim was deliberately built to avoid.
     */
    it('refuses a second live topic on a day that already has one', async () => {
      const accountId = await insertAccount(pool, 'calendar@example.com')
      const first = await anOpportunity(accountId, 'cluster:one')
      const second = await anOpportunity(accountId, 'cluster:two')
      await aTopic(accountId, first, '2026-10-01')

      const rejected = await aTopic(accountId, second, '2026-10-01').catch((e) => e)
      expect(pgErrorCode(rejected)).toBe(EXCLUSION_VIOLATION)
    })

    /**
     * Every state a topic reaches after it has been dequeued still occupies the
     * day. That is what turns "one live topic a day" into the rule the product
     * actually needs — at most one topic dequeues per store per day.
     */
    it.each(['generating', 'in_review', 'published', 'rejected_by_gate'])(
      'still holds the day against a topic that is %s',
      async (state) => {
        const accountId = await insertAccount(pool, `state-${state}@example.com`)
        const first = await anOpportunity(accountId, 'cluster:one')
        const second = await anOpportunity(accountId, 'cluster:two')
        await aTopic(accountId, first, '2026-10-01', state)

        const rejected = await aTopic(accountId, second, '2026-10-01').catch((e) => e)
        expect(pgErrorCode(rejected)).toBe(EXCLUSION_VIOLATION)
      },
    )

    /**
     * A veto frees the day. The calendar keeps the gap and replenishment fills
     * it later, and the three places that ask what a day holds already ignore
     * vetoed rows — so the index has to ignore them too, or a merchant who
     * changes their mind loses the day for good.
     */
    it('lets a vetoed day be used again', async () => {
      const accountId = await insertAccount(pool, 'vetoed@example.com')
      const first = await anOpportunity(accountId, 'cluster:one')
      const second = await anOpportunity(accountId, 'cluster:two')
      await aTopic(accountId, first, '2026-10-01', 'vetoed')

      await expect(aTopic(accountId, second, '2026-10-01')).resolves.toBeDefined()
    })

    it('allows any number of vetoed topics on the same day', async () => {
      const accountId = await insertAccount(pool, 'many-vetoes@example.com')
      const first = await anOpportunity(accountId, 'cluster:one')
      const second = await anOpportunity(accountId, 'cluster:two')
      await aTopic(accountId, first, '2026-10-01', 'vetoed')

      await expect(aTopic(accountId, second, '2026-10-01', 'vetoed')).resolves.toBeDefined()
    })

    it('is per store, not across stores', async () => {
      const mine = await insertAccount(pool, 'mine@example.com')
      const theirs = await insertAccount(pool, 'theirs@example.com')
      await aTopic(mine, await anOpportunity(mine, 'cluster:one'), '2026-10-01')

      await expect(
        aTopic(theirs, await anOpportunity(theirs, 'cluster:one'), '2026-10-01'),
      ).resolves.toBeDefined()
    })

    it('leaves the next day free', async () => {
      const accountId = await insertAccount(pool, 'nextday@example.com')
      const first = await anOpportunity(accountId, 'cluster:one')
      const second = await anOpportunity(accountId, 'cluster:two')
      await aTopic(accountId, first, '2026-10-01')

      await expect(aTopic(accountId, second, '2026-10-02')).resolves.toBeDefined()
    })
  })

  // ── every gate verdict names the bar it was held to ────────────────────────

  describe('a gate decision records the thresholds it was reached under', () => {
    async function aTopicToJudge(): Promise<{ accountId: string; topicId: string }> {
      const accountId = await insertAccount(pool, 'gates@example.com')
      const opportunity = await anOpportunity(accountId, 'cluster:sizing')
      return { accountId, topicId: await aTopic(accountId, opportunity, '2026-10-01') }
    }

    it('refuses a verdict that does not say which bar it was held to', async () => {
      const { accountId, topicId } = await aTopicToJudge()
      const rejected = await pool
        .query(
          `INSERT INTO gate_decisions (account_id, topic_id, gate, outcome)
           VALUES ($1,$2,3,'rejected_after_repair')`,
          [accountId, topicId],
        )
        .catch((e) => e)
      expect(pgErrorCode(rejected)).toBe(NOT_NULL_VIOLATION)
    })

    /**
     * The version stored is the store's own resolved one, base thresholds with
     * its overrides folded in — which is the whole reason a column was worth
     * having. A global hash would answer the wrong question for any store that
     * has ever had a threshold moved for it.
     */
    it('keeps the store-resolved version, overrides and all', async () => {
      const { accountId, topicId } = await aTopicToJudge()
      await pool.query(
        `INSERT INTO gate_decisions (account_id, topic_id, gate, outcome, rules_version)
         VALUES ($1,$2,3,'passed',$3)`,
        [accountId, topicId, 'abc123+ov.da-DK-1'],
      )

      const { rows } = await pool.query<{ rules_version: string }>(
        `SELECT rules_version FROM gate_decisions WHERE account_id = $1`,
        [accountId],
      )
      expect(rows[0]!.rules_version).toBe('abc123+ov.da-DK-1')
    })
  })
})
