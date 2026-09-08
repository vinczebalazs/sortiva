import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import {
  CHECK_VIOLATION,
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
 * T4.0 done-when: "constraint tests fire; a claim row cannot exist without at
 * least one evidence entry; a reference row names at least one field to
 * render" — plus the card's own named cases (`publish_intents` unique
 * external id; `topics` ↔ `opportunities` FK) and one case for each item the
 * integrator's collected deferral list added to this wave.
 *
 * Every case talks to a real Postgres and asserts on the error code the
 * database raised, on the same footing as `constraints-wave2.test.ts`.
 */

const available = await databaseAvailable()

describe.skipIf(!available)('schema wave 3 constraints (T4.0)', () => {
  let ctx: TestDb
  let pool: pg.Pool

  beforeAll(async () => {
    ctx = await setupTestDb('constraints_wave3')
    pool = ctx.pool
  }, 60_000)

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(pool)
  })

  const insertOpportunity = async (accountId: string, entityRef = 'cluster:trail-shoes') => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO opportunities
         (account_id, signal_type, entity_type, entity_ref, evidence_json, impact,
          impact_score, confidence, reason_template_key, recommended_action, rules_version)
       VALUES ($1,'uncovered_commercial_query','query_cluster',$2,'[]'::jsonb,'high',
          80, 70, 'uncovered_commercial_query.default', 'create', 'abc123')
       RETURNING id`,
      [accountId, entityRef],
    )
    return rows[0]!.id
  }

  const insertTopic = async (
    accountId: string,
    opportunityId: string,
    overrides: { scheduledDate?: string } = {},
  ) => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO topics
         (account_id, opportunity_id, title, intent_class, source, scheduled_date)
       VALUES ($1,$2,'Best trail shoes','buying_guide','auto',$3)
       RETURNING id`,
      [accountId, opportunityId, overrides.scheduledDate ?? '2026-10-01'],
    )
    return rows[0]!.id
  }

  const insertArticle = async (accountId: string, topicId: string, slug = 'best-trail-shoes') => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO articles (account_id, topic_id, title, slug)
       VALUES ($1,$2,'Best trail shoes',$3)
       RETURNING id`,
      [accountId, topicId, slug],
    )
    return rows[0]!.id
  }

  describe('topics ↔ opportunities — main §8.1: "every topic carries its opportunity_id"', () => {
    it('refuses a topic naming an opportunity that does not exist', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      const fake = '00000000-0000-0000-0000-000000000000'
      const rejected = await insertTopic(a, fake).catch((e) => e)
      expect(pgErrorCode(rejected)).toBe(FOREIGN_KEY_VIOLATION)
    })

    it('refuses a topic with no opportunity at all', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      const rejected = await pool
        .query(
          `INSERT INTO topics (account_id, title, intent_class, source, scheduled_date)
           VALUES ($1,'Best trail shoes','buying_guide','auto','2026-10-01')`,
          [a],
        )
        .catch((e) => e)
      expect(pgErrorCode(rejected)).toBe(NOT_NULL_VIOLATION)
    })

    it('accepts a topic naming a real opportunity', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      const opp = await insertOpportunity(a)
      await expect(insertTopic(a, opp)).resolves.toBeDefined()
    })
  })

  describe('publish_intents — main §14.3.7: article_external_id is the global dedupe', () => {
    const insertIntent = (accountId: string, externalId: string) =>
      pool.query(
        `INSERT INTO publish_intents (article_external_id, account_id) VALUES ($1,$2)`,
        [externalId, accountId],
      )

    it('rejects a second worker racing the same publish', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      await insertIntent(a, 'article:123')
      const clash = await insertIntent(a, 'article:123').catch((e) => e)
      expect(pgErrorCode(clash)).toBe(UNIQUE_VIOLATION)
    })

    it('is unique globally, not just per account — the id already names the article', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      const b = await insertAccount(pool, 'b@example.com')
      await insertIntent(a, 'article:456')
      const clash = await insertIntent(b, 'article:456').catch((e) => e)
      expect(pgErrorCode(clash)).toBe(UNIQUE_VIOLATION)
    })

    it('lets a revision use its own external id, per §14.3.7 step 5', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      await insertIntent(a, 'article:789')
      await expect(insertIntent(a, 'article:789‖1')).resolves.toBeDefined()
    })
  })

  describe('article_claims — content-pointers.md §1: a claim without evidence is not a claim', () => {
    const insertClaim = (articleId: string, evidence: string) =>
      pool.query(
        `INSERT INTO article_claims (article_id, text, kind, confidence, evidence_json)
         VALUES ($1,'Model B holds 2L more than Model A','derived_fact','high',$2::jsonb)`,
        [articleId, evidence],
      )

    it('refuses a claim with no evidence entries', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      const opp = await insertOpportunity(a)
      const topic = await insertTopic(a, opp)
      const article = await insertArticle(a, topic)
      const rejected = await insertClaim(article, '[]').catch((e) => e)
      expect(pgErrorCode(rejected)).toBe(CHECK_VIOLATION)
    })

    it('refuses evidence that is not an array at all', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      const opp = await insertOpportunity(a)
      const topic = await insertTopic(a, opp)
      const article = await insertArticle(a, topic)
      const rejected = await insertClaim(article, '{}').catch((e) => e)
      expect(pgErrorCode(rejected)).toBe(CHECK_VIOLATION)
    })

    it('accepts a claim with at least one evidence entry', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      const opp = await insertOpportunity(a)
      const topic = await insertTopic(a, opp)
      const article = await insertArticle(a, topic)
      const evidence = JSON.stringify([{ type: 'product', ref: 'shoe-1' }])
      await expect(insertClaim(article, evidence)).resolves.toBeDefined()
    })
  })

  describe('article_product_refs — done-when: "a reference row names at least one field to render"', () => {
    const insertRef = (articleId: string, fields: string) =>
      pool.query(
        `INSERT INTO article_product_refs (article_id, ref_type, placeholder_key, fields_rendered)
         VALUES ($1,'mention','ref-1',${fields})`,
        [articleId],
      )

    it('refuses a reference naming no fields', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      const opp = await insertOpportunity(a)
      const topic = await insertTopic(a, opp)
      const article = await insertArticle(a, topic)
      const rejected = await insertRef(article, `'{}'::product_ref_field[]`).catch((e) => e)
      expect(pgErrorCode(rejected)).toBe(CHECK_VIOLATION)
    })

    it('accepts a reference naming at least one field', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      const opp = await insertOpportunity(a)
      const topic = await insertTopic(a, opp)
      const article = await insertArticle(a, topic)
      await expect(
        insertRef(article, `'{price}'::product_ref_field[]`),
      ).resolves.toBeDefined()
    })

    it('keeps the reference row when its product is deleted, per content-pointers.md §9', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      const opp = await insertOpportunity(a)
      const topic = await insertTopic(a, opp)
      const article = await insertArticle(a, topic)
      const { rows: fam } = await pool.query<{ id: string }>(
        `INSERT INTO product_families (account_id, name, grouping_source, confidence)
         VALUES ($1,'Trail shoes','fact_cluster','high') RETURNING id`,
        [a],
      )
      const { rows: prod } = await pool.query<{ id: string }>(
        `INSERT INTO products (account_id, shopify_product_id, title, family_id)
         VALUES ($1,'sp-1','Trailblazer',$2) RETURNING id`,
        [a, fam[0]!.id],
      )
      await pool.query(
        `INSERT INTO article_product_refs (article_id, product_id, ref_type, placeholder_key, fields_rendered)
         VALUES ($1,$2,'link','ref-price','{price,url}'::product_ref_field[])`,
        [article, prod[0]!.id],
      )
      await pool.query('DELETE FROM products WHERE id = $1', [prod[0]!.id])

      const { rows } = await pool.query<{ product_id: string | null }>(
        `SELECT product_id FROM article_product_refs WHERE article_id = $1`,
        [article],
      )
      // The publish-fails-and-repairs behaviour this enables is T5.2/T5.3's; here
      // only the storage shape is asserted — the row survives, with its dangling
      // reference now visible as a null product_id rather than the row vanishing.
      expect(rows).toHaveLength(1)
      expect(rows[0]!.product_id).toBeNull()
    })
  })

  describe('gate_decisions — main §13: gate is one of the three gates', () => {
    const insertDecision = (accountId: string, topicId: string, gate: number) =>
      pool.query(
        `INSERT INTO gate_decisions (account_id, topic_id, gate, outcome, rules_version)
         VALUES ($1,$2,$3,'pass','rules-test-v1')`,
        [accountId, topicId, gate],
      )

    it('refuses a gate number outside 1–3', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      const opp = await insertOpportunity(a)
      const topic = await insertTopic(a, opp)
      const rejected = await insertDecision(a, topic, 4).catch((e) => e)
      expect(pgErrorCode(rejected)).toBe(CHECK_VIOLATION)
    })

    it('accepts each of the three gates', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      const opp = await insertOpportunity(a)
      const topic = await insertTopic(a, opp)
      for (const gate of [1, 2, 3]) {
        await expect(insertDecision(a, topic, gate)).resolves.toBeDefined()
      }
    })
  })

  describe('cross-table FKs schema wave 3 completes (store_pages, opportunities → topics/articles)', () => {
    it('store_pages.article_id now rejects an article that does not exist', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      const fake = '00000000-0000-0000-0000-000000000000'
      const rejected = await pool
        .query(
          `INSERT INTO store_pages (account_id, url, page_type, article_id) VALUES ($1,'/a','article_ours',$2)`,
          [a, fake],
        )
        .catch((e) => e)
      expect(pgErrorCode(rejected)).toBe(FOREIGN_KEY_VIOLATION)
    })

    it('opportunities.topic_id and .article_id now reject ids that do not exist', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      const fake = '00000000-0000-0000-0000-000000000000'
      const rejected = await pool
        .query(
          `INSERT INTO opportunities
             (account_id, signal_type, entity_type, entity_ref, evidence_json, impact,
              impact_score, confidence, reason_template_key, recommended_action, rules_version, topic_id)
           VALUES ($1,'cannibalization','url','/x','[]'::jsonb,'low',1,1,'k','optimize','v',$2)`,
          [a, fake],
        )
        .catch((e) => e)
      expect(pgErrorCode(rejected)).toBe(FOREIGN_KEY_VIOLATION)
    })

    it('resolves store_pages.article_id to null rather than blocking article deletion', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      const opp = await insertOpportunity(a)
      const topic = await insertTopic(a, opp)
      const article = await insertArticle(a, topic)
      await pool.query(
        `INSERT INTO store_pages (account_id, url, page_type, article_id) VALUES ($1,'/a','article_ours',$2)`,
        [a, article],
      )
      await pool.query('DELETE FROM articles WHERE id = $1', [article])
      const { rows } = await pool.query<{ article_id: string | null }>(
        `SELECT article_id FROM store_pages WHERE account_id = $1`,
        [a],
      )
      expect(rows[0]!.article_id).toBeNull()
    })
  })

  // ── The integrator's collected deferral list — one meaningful case each ────

  describe('products.options / products.metafields — deferred by T2.4, collected for this wave', () => {
    it('defaults both to an empty JSON array on a plain catalogue sync insert', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      const { rows } = await pool.query<{ options: unknown; metafields: unknown }>(
        `INSERT INTO products (account_id, shopify_product_id, title)
         VALUES ($1,'sp-1','Trailblazer') RETURNING options, metafields`,
        [a],
      )
      expect(rows[0]!.options).toEqual([])
      expect(rows[0]!.metafields).toEqual([])
    })
  })

  describe('gsc_monthly / gsc_query_monthly — deferred by T8.3, collected for this wave', () => {
    it('holds one row per (account, month, page)', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      await pool.query(
        `INSERT INTO gsc_monthly (account_id, month, page, clicks) VALUES ($1,'2026-08-01','/x',10)`,
        [a],
      )
      const dup = await pool
        .query(
          `INSERT INTO gsc_monthly (account_id, month, page, clicks) VALUES ($1,'2026-08-01','/x',99)`,
          [a],
        )
        .catch((e) => e)
      expect(pgErrorCode(dup)).toBe(UNIQUE_VIOLATION)
    })

    it('holds one row per (account, month, page, query)', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      await pool.query(
        `INSERT INTO gsc_query_monthly (account_id, month, page, query, clicks) VALUES ($1,'2026-08-01','/x','trail shoes',10)`,
        [a],
      )
      const dup = await pool
        .query(
          `INSERT INTO gsc_query_monthly (account_id, month, page, query, clicks) VALUES ($1,'2026-08-01','/x','trail shoes',3)`,
          [a],
        )
        .catch((e) => e)
      expect(pgErrorCode(dup)).toBe(UNIQUE_VIOLATION)
    })
  })

  describe('spend_events.article_id — deferred by T8.4/R3, collected for this wave', () => {
    it('accepts an article id with no foreign key, so a discarded article never erases what it cost', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      const madeUpArticleId = '11111111-1111-1111-1111-111111111111'
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO spend_events (account_id, article_id, vendor, call_type, usd_cost, outcome)
         VALUES ($1,$2,'anthropic','draft',0.05,'succeeded') RETURNING id`,
        [a, madeUpArticleId],
      )
      expect(rows[0]!.id).toBeDefined()
      // The article id was never real, and the row is untouched by that: the
      // whole point is that this ledger carries no foreign key to erase.
      const { rows: after } = await pool.query(`SELECT article_id FROM spend_events WHERE id = $1`, [
        rows[0]!.id,
      ])
      expect(after[0]!.article_id).toBe(madeUpArticleId)
    })
  })

  describe('incident_findings — deferred by T8.4, collected for this wave', () => {
    const insertFlag = async (accountId: string) => {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO ops_flags (scope, account_id, flag, actor, reason, tripped_by)
         VALUES ('account',$1,'account.pause_generation','auto','spend spike','auto') RETURNING id`,
        [accountId],
      )
      return rows[0]!.id
    }

    it('refuses a finding naming a trip that does not exist', async () => {
      const fake = '00000000-0000-0000-0000-000000000000'
      const rejected = await pool
        .query(
          `INSERT INTO incident_findings (ops_flag_id, author, finding) VALUES ($1,'ops','looked into it')`,
          [fake],
        )
        .catch((e) => e)
      expect(pgErrorCode(rejected)).toBe(FOREIGN_KEY_VIOLATION)
    })

    it('lets more than one finding attach to the same trip, as the investigation continues', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      const flag = await insertFlag(a)
      await pool.query(
        `INSERT INTO incident_findings (ops_flag_id, author, finding) VALUES ($1,'ops','first look: nothing obvious')`,
        [flag],
      )
      await pool.query(
        `INSERT INTO incident_findings (ops_flag_id, author, finding) VALUES ($1,'ops','second look: a vendor retry storm')`,
        [flag],
      )
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM incident_findings WHERE ops_flag_id = $1', [
        flag,
      ])
      expect(rows[0].n).toBe(2)
    })

    it('removes its findings when the trip row itself is removed', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      const flag = await insertFlag(a)
      await pool.query(
        `INSERT INTO incident_findings (ops_flag_id, author, finding) VALUES ($1,'ops','note')`,
        [flag],
      )
      await pool.query('DELETE FROM ops_flags WHERE id = $1', [flag])
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM incident_findings')
      expect(rows[0].n).toBe(0)
    })
  })

  describe('deletion_confirmation_emails — deferred by T8.2/T8.3, collected for this wave', () => {
    it('is unique per (account_id, dedupe_key), so a retried worker sends once', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      const insert = () =>
        pool.query(
          `INSERT INTO deletion_confirmation_emails (account_id, email, dedupe_key, template_version)
           VALUES ($1,'merchant@example.com','2026-09-03T00:00:00Z','v1')`,
          [a],
        )
      await insert()
      const clash = await insert().catch((e) => e)
      expect(pgErrorCode(clash)).toBe(UNIQUE_VIOLATION)
    })

    it('carries no foreign key, so the record survives its account row being gone', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      await pool.query(
        `INSERT INTO deletion_confirmation_emails (account_id, email, dedupe_key, template_version)
         VALUES ($1,'merchant@example.com','2026-09-03T00:00:00Z','v1')`,
        [a],
      )
      // Accounts are never hard-deleted directly in the product's own flow (the
      // sweep is what does it, and only after the grace window) — what matters
      // here is only that the schema itself does not force the record to go
      // with the account, the way `email_sends` (cascading) would.
      await pool.query('DELETE FROM accounts WHERE id = $1', [a])
      const { rows } = await pool.query(
        'SELECT account_id FROM deletion_confirmation_emails WHERE account_id = $1',
        [a],
      )
      expect(rows).toHaveLength(1)
    })

    it('accepts the new notification_type enum value elsewhere in the schema', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      await expect(
        pool.query(
          `INSERT INTO notifications (account_id, type, dedupe_key) VALUES ($1,'account_deletion_confirmed','once')`,
          [a],
        ),
      ).resolves.toBeDefined()
    })
  })
})

describe('database availability (wave 3)', () => {
  it('reports whether the constraint suite actually ran', () => {
    if (!available) {
      throw new Error(
        `No Postgres at the test URL. Constraint tests cannot be skipped silently — run \`pnpm db:up\` first.`,
      )
    }
    expect(available).toBe(true)
  })
})
