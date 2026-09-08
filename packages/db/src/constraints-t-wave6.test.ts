import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import {
  UNIQUE_VIOLATION,
  databaseAvailable,
  insertAccount,
  pgErrorCode,
  setupTestDb,
  truncateAll,
  type TestDb,
} from './testing'

/**
 * `T-WAVE6` is a migration-only mini-wave with two halves that share nothing
 * except the wave: a column dropped because the founder decided not to build
 * what would have filled it, and an index the override table has wanted since
 * the day it was first written to.
 *
 * The index half is the reason this suite exists rather than being folded into
 * a repository test. It is written in raw SQL in migration `0012` because the
 * schema builder cannot express `NULLS NOT DISTINCT`, which means **nothing in
 * the TypeScript schema shows that it is there** — so nothing but a test
 * against a real Postgres can tell whether it survived a future regeneration.
 */

const available = await databaseAvailable()

describe.skipIf(!available)('T-WAVE6 — a dropped column, and one row per override scope', () => {
  let ctx: TestDb
  let pool: pg.Pool

  beforeAll(async () => {
    ctx = await setupTestDb('constraints_t_wave6')
    pool = ctx.pool
  })

  afterAll(async () => {
    await ctx.close()
  })

  beforeEach(async () => {
    await truncateAll(pool)
  })

  /** An article is only reachable through the chain that says why it was written. */
  async function anArticle(): Promise<string> {
    const accountId = await insertAccount(pool, 'claims@example.com')
    const { rows: opportunity } = await pool.query<{ id: string }>(
      `INSERT INTO opportunities
         (account_id, signal_type, entity_type, entity_ref, evidence_json, impact,
          impact_score, confidence, reason_template_key, recommended_action, rules_version)
       VALUES ($1,'uncovered_commercial_query','query_cluster','cluster:sizing','[]'::jsonb,'high',
          80, 70, 'uncovered_commercial_query.default', 'create', 'abc123')
       RETURNING id`,
      [accountId],
    )
    const { rows: topic } = await pool.query<{ id: string }>(
      `INSERT INTO topics (account_id, opportunity_id, title, intent_class, source, scheduled_date)
       VALUES ($1,$2,'Trail shoe sizing','buying_guide','auto','2026-10-01')
       RETURNING id`,
      [accountId, opportunity[0]!.id],
    )
    const { rows: article } = await pool.query<{ id: string }>(
      `INSERT INTO articles (account_id, topic_id, title, slug)
       VALUES ($1,$2,'Trail shoe sizing','trail-shoe-sizing')
       RETURNING id`,
      [accountId, topic[0]!.id],
    )
    return article[0]!.id
  }

  describe('the claim staleness column is gone', () => {
    it('has no staleness column on article_claims', async () => {
      const { rows } = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'article_claims' AND column_name = 'staleness'`,
      )
      expect(rows).toHaveLength(0)
    })

    it('has no claim_staleness type left behind', async () => {
      const { rows } = await pool.query<{ typname: string }>(
        `SELECT typname FROM pg_type WHERE typname = 'claim_staleness'`,
      )
      expect(rows).toHaveLength(0)
    })

    it('still stores a claim, which is the half of this table that was always real', async () => {
      const { rows } = await pool.query<{ text: string }>(
        `INSERT INTO article_claims (article_id, text, kind, confidence, evidence_json)
         VALUES ($1,'The Trailblazer runs half a size small','merchant_fact','high','[{"productId":"p1"}]'::jsonb)
         RETURNING text`,
        [await anArticle()],
      )
      expect(rows[0]!.text).toContain('half a size small')
    })
  })

  describe('one override per scope', () => {
    /**
     * The case the ordinary unique index would have let through. Two global
     * overrides of the same threshold have null in all three scope columns, and
     * Postgres counts two nulls as different values unless told otherwise — so
     * without `NULLS NOT DISTINCT` this second insert succeeds and the layering
     * then applies whichever row happens to sort last.
     */
    it('refuses a second global override of the same threshold', async () => {
      await pool.query(
        `INSERT INTO rules_overrides (key, value, updated_by) VALUES ('gates.demand_floor','12'::jsonb,'balazs')`,
      )
      const rejected = await pool
        .query(
          `INSERT INTO rules_overrides (key, value, updated_by) VALUES ('gates.demand_floor','30'::jsonb,'balazs')`,
        )
        .catch((e) => e)
      expect(pgErrorCode(rejected)).toBe(UNIQUE_VIOLATION)
    })

    it('refuses a second override of the same threshold for the same store', async () => {
      const accountId = await insertAccount(pool, 'override@example.com')
      await pool.query(
        `INSERT INTO rules_overrides (account_id, key, value, updated_by) VALUES ($1,'gates.demand_floor','12'::jsonb,'balazs')`,
        [accountId],
      )
      const rejected = await pool
        .query(
          `INSERT INTO rules_overrides (account_id, key, value, updated_by) VALUES ($1,'gates.demand_floor','30'::jsonb,'balazs')`,
          [accountId],
        )
        .catch((e) => e)
      expect(pgErrorCode(rejected)).toBe(UNIQUE_VIOLATION)
    })

    it('still allows the same threshold at different scopes, which is the whole point of the table', async () => {
      const accountId = await insertAccount(pool, 'scopes@example.com')
      await pool.query(
        `INSERT INTO rules_overrides (key, value, updated_by) VALUES ('gates.demand_floor','12'::jsonb,'balazs')`,
      )
      await pool.query(
        `INSERT INTO rules_overrides (locale, key, value, updated_by) VALUES ('da-DK','gates.demand_floor','8'::jsonb,'balazs')`,
      )
      await pool.query(
        `INSERT INTO rules_overrides (page_type, key, value, updated_by) VALUES ('collection','gates.demand_floor','20'::jsonb,'balazs')`,
      )
      await pool.query(
        `INSERT INTO rules_overrides (account_id, key, value, updated_by) VALUES ($1,'gates.demand_floor','30'::jsonb,'balazs')`,
        [accountId],
      )
      const { rows } = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM rules_overrides WHERE key = 'gates.demand_floor'`,
      )
      expect(rows[0]!.count).toBe('4')
    })

    it('is a real index rather than a hopeful comment', async () => {
      const { rows } = await pool.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE indexname = 'rules_overrides_scope_key'`,
      )
      expect(rows).toHaveLength(1)
      // The clause nothing in the TypeScript schema can show, and the whole
      // reason the two tests above pass.
      expect(rows[0]!.indexdef).toContain('NULLS NOT DISTINCT')
    })
  })
})
