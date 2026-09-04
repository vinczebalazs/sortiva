import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import {
  FOREIGN_KEY_VIOLATION,
  NOT_NULL_VIOLATION,
  UNIQUE_VIOLATION,
  databaseAvailable,
  insertAccount,
  pgErrorCode,
  setupTestDb,
  truncateAll,
  type TestDb,
} from './testing'

/**
 * `T-WAVE5` is a migration-only mini-wave: two additions, and nothing in the
 * product reads or writes either yet. Its done-whens are "the migration applies
 * forward from an empty database; an article can still exist in every state it
 * could before; a session row can be written and deleted" — which is what these
 * tests check, against a real Postgres, the way `constraints-t4-0a.test.ts` and
 * `constraints-t4-0b.test.ts` do for the two mini-waves before it.
 *
 * The forward-from-empty half is proved by the harness itself: `setupTestDb`
 * creates a database of its own and applies every committed migration in order
 * before a single test runs.
 */

const available = await databaseAvailable()

describe.skipIf(!available)('T-WAVE5 — a cleared article state, and sessions that can be ended', () => {
  let ctx: TestDb
  let pool: pg.Pool

  beforeAll(async () => {
    ctx = await setupTestDb('constraints_t_wave5')
    pool = ctx.pool
  }, 60_000)

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(pool)
  })

  async function anArticle(slug: string): Promise<string> {
    const accountId = await insertAccount(pool, `${slug}@example.com`)
    // A topic must come from an opportunity, and an article from a topic — the
    // chain that makes an article traceable back to why it was written.
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
       VALUES ($1,$2,'Best trail shoes','buying_guide','auto','2026-10-01')
       RETURNING id`,
      [accountId, opportunity[0]!.id],
    )
    const { rows: article } = await pool.query<{ id: string }>(
      `INSERT INTO articles (account_id, topic_id, title, slug)
       VALUES ($1,$2,'Best trail shoes',$3)
       RETURNING id`,
      [accountId, topic[0]!.id, slug],
    )
    return article[0]!.id
  }

  describe('articles.state', () => {
    // The addition must not invalidate anything already stored, so every value
    // an article could hold yesterday is checked one at a time.
    const stateItCouldHoldBefore = ['draft', 'in_review', 'published', 'rejected', 'discarded']

    it.each(stateItCouldHoldBefore)('still accepts %s', async (state) => {
      const id = await anArticle(`existing-${state.replace(/_/g, '-')}`)
      await pool.query(`UPDATE articles SET state = $2 WHERE id = $1`, [id, state])
      const { rows } = await pool.query<{ state: string }>(
        `SELECT state FROM articles WHERE id = $1`,
        [id],
      )
      expect(rows[0]!.state).toBe(state)
    })

    it('still starts a new article as a draft', async () => {
      const id = await anArticle('fresh')
      const { rows } = await pool.query<{ state: string }>(
        `SELECT state FROM articles WHERE id = $1`,
        [id],
      )
      expect(rows[0]!.state).toBe('draft')
    })

    it('accepts the new state, cleared_to_deliver', async () => {
      const id = await anArticle('overruled')
      await pool.query(`UPDATE articles SET state = 'cleared_to_deliver' WHERE id = $1`, [id])
      const { rows } = await pool.query<{ state: string }>(
        `SELECT state FROM articles WHERE id = $1`,
        [id],
      )
      expect(rows[0]!.state).toBe('cleared_to_deliver')
    })

    it('rejects a state outside the named set', async () => {
      const id = await anArticle('invented')
      const rejected = await pool
        .query(`UPDATE articles SET state = 'cleared' WHERE id = $1`, [id])
        .catch((e) => e)
      // A native Postgres enum refuses an unknown label as invalid input rather
      // than as a named constraint violation.
      expect(pgErrorCode(rejected)).toBe('22P02')
    })
  })

  describe('sessions', () => {
    async function aSession(token: string, accountId: string): Promise<void> {
      await pool.query(
        `INSERT INTO sessions (session_token, account_id, expires)
         VALUES ($1, $2, now() + interval '1 day')`,
        [token, accountId],
      )
    }

    it('can be written and then deleted, which is what revoking one will be', async () => {
      const accountId = await insertAccount(pool, 'signed-in@example.com')
      await aSession('tok-1', accountId)

      const { rows } = await pool.query<{ account_id: string; expires: Date; created_at: Date }>(
        `SELECT account_id, expires, created_at FROM sessions WHERE session_token = 'tok-1'`,
      )
      expect(rows[0]!.account_id).toBe(accountId)
      expect(rows[0]!.expires.getTime()).toBeGreaterThan(Date.now())
      expect(rows[0]!.created_at).toBeInstanceOf(Date)

      const removed = await pool.query(`DELETE FROM sessions WHERE session_token = 'tok-1'`)
      expect(removed.rowCount).toBe(1)
      const { rowCount } = await pool.query(`SELECT 1 FROM sessions WHERE session_token = 'tok-1'`)
      expect(rowCount).toBe(0)
    })

    it('holds one row per browser, so all of an account can be ended at once', async () => {
      const accountId = await insertAccount(pool, 'two-browsers@example.com')
      const other = await insertAccount(pool, 'somebody-else@example.com')
      await aSession('tok-laptop', accountId)
      await aSession('tok-phone', accountId)
      await aSession('tok-theirs', other)

      const ended = await pool.query(`DELETE FROM sessions WHERE account_id = $1`, [accountId])
      expect(ended.rowCount).toBe(2)
      const { rows } = await pool.query<{ session_token: string }>(`SELECT session_token FROM sessions`)
      expect(rows.map((r) => r.session_token)).toEqual(['tok-theirs'])
    })

    it('takes an account’s sessions with it when the account row goes', async () => {
      const accountId = await insertAccount(pool, 'deleted@example.com')
      await aSession('tok-doomed', accountId)
      await pool.query(`DELETE FROM accounts WHERE id = $1`, [accountId])
      const { rowCount } = await pool.query(`SELECT 1 FROM sessions`)
      expect(rowCount).toBe(0)
    })

    it('refuses a second row for the same token', async () => {
      const accountId = await insertAccount(pool, 'a@example.com')
      const other = await insertAccount(pool, 'b@example.com')
      await aSession('tok-shared', accountId)
      const rejected = await aSession('tok-shared', other).catch((e) => e)
      expect(pgErrorCode(rejected)).toBe(UNIQUE_VIOLATION)
    })

    it('refuses a session belonging to no account', async () => {
      const rejected = await pool
        .query(
          `INSERT INTO sessions (session_token, account_id, expires)
           VALUES ('tok-orphan', '00000000-0000-0000-0000-000000000000', now() + interval '1 day')`,
        )
        .catch((e) => e)
      expect(pgErrorCode(rejected)).toBe(FOREIGN_KEY_VIOLATION)
    })

    it('refuses a session with no expiry', async () => {
      const accountId = await insertAccount(pool, 'a@example.com')
      const rejected = await pool
        .query(`INSERT INTO sessions (session_token, account_id, expires) VALUES ('tok-forever',$1,NULL)`, [
          accountId,
        ])
        .catch((e) => e)
      expect(pgErrorCode(rejected)).toBe(NOT_NULL_VIOLATION)
    })
  })
})
