import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import {
  CHECK_VIOLATION,
  RESTRICT_VIOLATION,
  UNIQUE_VIOLATION,
  databaseAvailable,
  insertAccount,
  pgErrorCode,
  setupTestDb,
  truncateAll,
  type TestDb,
} from './testing'

/**
 * T2.0 done-when: "constraint tests fire; count constraint rejects a 6th
 * competitor at DB level."
 *
 * Every case here talks to a real Postgres and asserts on the error code the
 * *database* raised. These are the rules that must hold in the DB, not just
 * the UI / not just application code", and only a real database can show that.
 *
 * The suite fails loudly rather than skipping when no database is reachable —
 * see the final describe block. A silently-skipped constraint suite reports
 * green while proving nothing.
 */

const available = await databaseAvailable()

describe.skipIf(!available)('schema wave 2 constraints', () => {
  let ctx: TestDb
  let pool: pg.Pool

  beforeAll(async () => {
    ctx = await setupTestDb('constraints_wave2')
    pool = ctx.pool
  })

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(pool)
  })

  const addCompetitor = (accountId: string, domain: string) =>
    pool.query(
      `INSERT INTO competitors (account_id, domain_normalized, source) VALUES ($1, $2, 'auto')`,
      [accountId, domain],
    )

  describe('competitors — invariant 5, the hard cap of 5 (main §6.6)', () => {
    it('accepts five business competitors and rejects the sixth at the database', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      for (let i = 1; i <= 5; i++) await addCompetitor(a, `rival${i}.example.com`)

      const sixth = await addCompetitor(a, 'rival6.example.com').catch((e) => e)
      expect(pgErrorCode(sixth)).toBe(CHECK_VIOLATION)
      expect(String(sixth.message)).toContain('the cap is 5')

      const { rows } = await pool.query('SELECT count(*)::int AS n FROM competitors')
      expect(rows[0].n).toBe(5)
    })

    it('caps each account separately', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      const b = await insertAccount(pool, 'b@example.com')
      for (let i = 1; i <= 5; i++) await addCompetitor(a, `rival${i}.example.com`)
      // b is untouched by a's cap.
      for (let i = 1; i <= 5; i++) await addCompetitor(b, `rival${i}.example.com`)

      expect(pgErrorCode(await addCompetitor(b, 'rival6.example.com').catch((e) => e))).toBe(
        CHECK_VIOLATION,
      )
    })

    it('frees a slot when a competitor is removed', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      for (let i = 1; i <= 5; i++) await addCompetitor(a, `rival${i}.example.com`)
      await pool.query(`DELETE FROM competitors WHERE domain_normalized = 'rival3.example.com'`)
      await expect(addCompetitor(a, 'newrival.example.com')).resolves.toBeDefined()
    })

    it('holds under concurrency: six simultaneous inserts leave five rows', async () => {
      // The reason the cap is a locking trigger rather than a plain count: under
      // READ COMMITTED, six transactions each counting rows would each see fewer
      // than five and all six would land.
      const a = await insertAccount(pool, 'a@example.com')
      const attempts = await Promise.allSettled(
        Array.from({ length: 6 }, (_, i) => addCompetitor(a, `race${i}.example.com`)),
      )
      expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(5)

      const { rows } = await pool.query('SELECT count(*)::int AS n FROM competitors')
      expect(rows[0].n).toBe(5)
    })

    it('rejects moving a competitor onto an account that is already full', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      const b = await insertAccount(pool, 'b@example.com')
      for (let i = 1; i <= 5; i++) await addCompetitor(a, `rival${i}.example.com`)
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO competitors (account_id, domain_normalized, source) VALUES ($1,'other.example.com','manual') RETURNING id`,
        [b],
      )
      const moved = await pool
        .query('UPDATE competitors SET account_id = $1 WHERE id = $2', [a, rows[0]!.id])
        .catch((e) => e)
      expect(pgErrorCode(moved)).toBe(CHECK_VIOLATION)
    })

    it('rejects the same competitor domain twice on one account', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      await addCompetitor(a, 'rival.example.com')
      expect(pgErrorCode(await addCompetitor(a, 'rival.example.com').catch((e) => e))).toBe(
        UNIQUE_VIOLATION,
      )
    })
  })

  describe('opportunities — invariant 10, dedupe on the open row (main §7.9)', () => {
    const insertOpportunity = (
      accountId: string,
      status = 'new',
      entityRef = 'cluster:trail-running-shoes',
    ) =>
      pool.query(
        `INSERT INTO opportunities
           (account_id, signal_type, entity_type, entity_ref, evidence_json, impact,
            impact_score, confidence, reason_template_key, recommended_action, status, rules_version)
         VALUES ($1,'striking_distance','query_cluster',$2,'[]'::jsonb,'high',
            80, 70, 'striking_distance.default', 'optimize', $3, 'abc123')`,
        [accountId, entityRef, status],
      )

    it('refuses a duplicate open row for the same (account, signal, entity)', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      await insertOpportunity(a)
      const duplicate = await insertOpportunity(a).catch((e) => e)
      expect(pgErrorCode(duplicate)).toBe(UNIQUE_VIOLATION)
    })

    it('covers every open status the spec lists', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      for (const status of ['new', 'accepted', 'scheduled', 'executing', 'blocked']) {
        await truncateAll(pool)
        const account = await insertAccount(pool, `${status}@example.com`)
        await insertOpportunity(account, status)
        expect(pgErrorCode(await insertOpportunity(account, status).catch((e) => e))).toBe(
          UNIQUE_VIOLATION,
        )
      }
      expect(a).toBeDefined()
    })

    it('lets closed rows accumulate as history beside a new open one', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      // Completed and expired rows stay as history and feed the learning loop.
      for (const status of ['completed', 'dismissed', 'expired']) {
        await insertOpportunity(a, status)
      }
      await expect(insertOpportunity(a, 'new')).resolves.toBeDefined()

      const { rows } = await pool.query('SELECT count(*)::int AS n FROM opportunities')
      expect(rows[0].n).toBe(4)
    })

    it('separates the key by account, by signal type, and by entity', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      const b = await insertAccount(pool, 'b@example.com')
      await insertOpportunity(a)
      await expect(insertOpportunity(b)).resolves.toBeDefined()
      await expect(insertOpportunity(a, 'new', 'cluster:other')).resolves.toBeDefined()
      await expect(
        pool.query(
          `INSERT INTO opportunities
             (account_id, signal_type, entity_type, entity_ref, evidence_json, impact,
              impact_score, confidence, reason_template_key, recommended_action, rules_version)
           VALUES ($1,'content_decay','query_cluster','cluster:trail-running-shoes','[]'::jsonb,
              'low', 10, 20, 'content_decay.default', 'refresh', 'abc123')`,
          [a],
        ),
      ).resolves.toBeDefined()
    })

    it('refuses a row that cannot explain itself (invariant 7)', async () => {
      // Evidence, impact, confidence, the reason key, the action and
      // rules_version "Required". A row without them is an unexplainable
      // recommendation, so the column list itself refuses it.
      const a = await insertAccount(pool, 'a@example.com')
      const noEvidence = await pool
        .query(
          `INSERT INTO opportunities
             (account_id, signal_type, entity_type, entity_ref, impact, impact_score,
              confidence, reason_template_key, recommended_action, rules_version)
           VALUES ($1,'striking_distance','url','/collections/x','high',10,10,'k','optimize','v')`,
          [a],
        )
        .catch((e) => e)
      expect(pgErrorCode(noEvidence)).toBe('23502')

      const noRulesVersion = await pool
        .query(
          `INSERT INTO opportunities
             (account_id, signal_type, entity_type, entity_ref, evidence_json, impact,
              impact_score, confidence, reason_template_key, recommended_action)
           VALUES ($1,'striking_distance','url','/collections/x','[]'::jsonb,'high',10,10,'k','optimize')`,
          [a],
        )
        .catch((e) => e)
      expect(pgErrorCode(noRulesVersion)).toBe('23502')
    })

    it('rejects a signal type that names no entry in signals.config.yaml', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      const bogus = await pool
        .query(
          `INSERT INTO opportunities
             (account_id, signal_type, entity_type, entity_ref, evidence_json, impact,
              impact_score, confidence, reason_template_key, recommended_action, rules_version)
           VALUES ($1,'made_up_signal','url','/x','[]'::jsonb,'high',10,10,'k','optimize','v')`,
          [a],
        )
        .catch((e) => e)
      // Invalid enum input: not a constraint code, but a hard refusal all the same.
      expect(pgErrorCode(bogus)).toBe('22P02')
    })
  })

  describe('store_pages — one row per URL per account (main §12.3)', () => {
    const addPage = (accountId: string, url: string) =>
      pool.query(
        `INSERT INTO store_pages (account_id, url, page_type) VALUES ($1,$2,'collection')`,
        [accountId, url],
      )

    it('rejects the same URL twice on one account', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      await addPage(a, 'https://shop.example.com/collections/trail')
      expect(
        pgErrorCode(await addPage(a, 'https://shop.example.com/collections/trail').catch((e) => e)),
      ).toBe(UNIQUE_VIOLATION)
    })

    it('lets two accounts hold the same URL', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      const b = await insertAccount(pool, 'b@example.com')
      await addPage(a, 'https://shop.example.com/collections/trail')
      await expect(addPage(b, 'https://shop.example.com/collections/trail')).resolves.toBeDefined()
    })
  })

  describe('spend_events — the meter behind the §14.5 caps (invariant 17)', () => {
    const spend = (columns: string, values: unknown[]) =>
      pool.query(
        `INSERT INTO spend_events (${columns}) VALUES (${values.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
        values,
      )

    it('records account spend and preview spend, and refuses anything else', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      await expect(
        spend('account_id, vendor, call_type, usd_cost, outcome', [
          a,
          'anthropic',
          'distill',
          '0.00031000',
          'succeeded',
        ]),
      ).resolves.toBeDefined()

      await expect(
        spend('preview_target, vendor, call_type, usd_cost, outcome', [
          'nike.com',
          'anthropic',
          'preview',
          '0.00120000',
          'succeeded',
        ]),
      ).resolves.toBeDefined()

      // The domain group is reserved for claimed domains, so a row is
      // never both an account's and a preview's.
      const both = await spend(
        'account_id, preview_target, vendor, call_type, usd_cost, outcome',
        [a, 'nike.com', 'anthropic', 'preview', '0.001', 'succeeded'],
      ).catch((e) => e)
      expect(pgErrorCode(both)).toBe(CHECK_VIOLATION)

      // Unattributed spend would be money nobody can be asked about.
      const neither = await spend('vendor, call_type, usd_cost, outcome', [
        'dataforseo',
        'serp',
        '0.0006',
        'succeeded',
      ]).catch((e) => e)
      expect(pgErrorCode(neither)).toBe(CHECK_VIOLATION)
    })

    it('records a cache replay at zero, and refuses a cache hit that claims a cost', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      await expect(
        spend('account_id, vendor, call_type, usd_cost, cache_hit, outcome', [
          a,
          'dataforseo',
          'serp',
          '0',
          true,
          'succeeded',
        ]),
      ).resolves.toBeDefined()

      const chargedReplay = await spend(
        'account_id, vendor, call_type, usd_cost, cache_hit, outcome',
        [a, 'dataforseo', 'serp', '0.0006', true, 'succeeded'],
      ).catch((e) => e)
      expect(pgErrorCode(chargedReplay)).toBe(CHECK_VIOLATION)
    })

    it('refuses a negative cost', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      const refund = await spend('account_id, vendor, call_type, usd_cost, outcome', [
        a,
        'anthropic',
        'judge',
        '-0.01',
        'succeeded',
      ]).catch((e) => e)
      expect(pgErrorCode(refund)).toBe(CHECK_VIOLATION)
    })

    it('is append-only: the database refuses an update', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      const { rows } = await spend('account_id, vendor, call_type, usd_cost, outcome', [
        a,
        'anthropic',
        'persona',
        '0.02',
        'succeeded',
      ])
      const update = await pool
        .query('UPDATE spend_events SET usd_cost = 0 WHERE id = $1', [rows[0]!.id])
        .catch((e) => e)
      expect(pgErrorCode(update)).toBe(RESTRICT_VIOLATION)
      expect(String(update.message)).toContain('append-only')

      const after = await pool.query('SELECT usd_cost FROM spend_events WHERE id = $1', [
        rows[0]!.id,
      ])
      expect(Number(after.rows[0].usd_cost)).toBeCloseTo(0.02)
    })

    it('records a failed call, because the vendor billed for it anyway', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      await expect(
        spend('account_id, vendor, call_type, usd_cost, outcome', [
          a,
          'anthropic',
          'optimize_reco',
          '0.004',
          'failed',
        ]),
      ).resolves.toBeDefined()
    })

    it('survives the deletion of the account that incurred it', async () => {
      // Account deletion removes personal data and order-derived aggregates. A vendor
      // invoice line is neither, and erasing money we spent is the opposite of
      // append-only — so this column carries no cascading foreign key.
      const a = await insertAccount(pool, 'a@example.com')
      await spend('account_id, vendor, call_type, usd_cost, outcome', [
        a,
        'anthropic',
        'seeds',
        '0.01',
        'succeeded',
      ])
      await pool.query('DELETE FROM accounts WHERE id = $1', [a])
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM spend_events')
      expect(rows[0].n).toBe(1)
    })

    it('sums a day of spend per account, which is what the §14.5 caps read', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      const b = await insertAccount(pool, 'b@example.com')
      for (const [account, cost] of [
        [a, '1.50'],
        [a, '2.25'],
        [a, '0'],
        [b, '9.99'],
      ] as const) {
        await spend('account_id, vendor, call_type, usd_cost, cache_hit, outcome', [
          account,
          'anthropic',
          'distill',
          cost,
          cost === '0',
          'succeeded',
        ])
      }
      const { rows } = await pool.query<{ total: string }>(
        `SELECT sum(usd_cost)::text AS total FROM spend_events
         WHERE account_id = $1 AND vendor = 'anthropic' AND occurred_at >= now() - interval '1 day'`,
        [a],
      )
      expect(Number(rows[0]!.total)).toBeCloseTo(3.75)
    })
  })

  describe('supporting wave-2 constraints', () => {
    it('keeps one keyword row per term per account', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      const insert = `INSERT INTO keywords (account_id, term, language, country, source) VALUES ($1,'trail running shoes','en','GB','auto')`
      await pool.query(insert, [a])
      expect(pgErrorCode(await pool.query(insert, [a]).catch((e) => e))).toBe(UNIQUE_VIOLATION)
    })

    it('keeps one GSC row per account, date, page, query and dimension pair', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      const insert = `INSERT INTO gsc_query_daily (account_id, date, page, query, device, country, clicks, impressions)
                      VALUES ($1,'2026-08-01','/collections/trail','trail shoes','MOBILE','gbr',3,90)`
      await pool.query(insert, [a])
      expect(pgErrorCode(await pool.query(insert, [a]).catch((e) => e))).toBe(UNIQUE_VIOLATION)
    })

    it('keeps one dismissal per (account, signal, entity) — the not-interested list', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      const insert = `INSERT INTO dismissed_opportunities (account_id, signal_type, entity_ref) VALUES ($1,'content_decay','/blog/x')`
      await pool.query(insert, [a])
      expect(pgErrorCode(await pool.query(insert, [a]).catch((e) => e))).toBe(UNIQUE_VIOLATION)
    })

    it('keeps one signal run per (account, run id)', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      const insert = `INSERT INTO signal_runs (account_id, run_id, kind, rules_version) VALUES ($1,'run-1','weekly','abc')`
      await pool.query(insert, [a])
      expect(pgErrorCode(await pool.query(insert, [a]).catch((e) => e))).toBe(UNIQUE_VIOLATION)
    })

    it('cascades wave-2 rows when an account is deleted (main §14.6)', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      const { rows: fam } = await pool.query<{ id: string }>(
        `INSERT INTO product_families (account_id, name, grouping_source, confidence) VALUES ($1,'Trail shoes','collection','high') RETURNING id`,
        [a],
      )
      const { rows: prod } = await pool.query<{ id: string }>(
        `INSERT INTO products (account_id, shopify_product_id, title, family_id) VALUES ($1,'gid://1','Trailblazer',$2) RETURNING id`,
        [a, fam[0]!.id],
      )
      await pool.query(
        `INSERT INTO product_facts (product_id, facts_json, prompt_version, model_id) VALUES ($1,'{}'::jsonb,'distill.v1','claude-haiku-4-5')`,
        [prod[0]!.id],
      )
      await pool.query(
        `INSERT INTO top_products (account_id, product_id, title, source, rank) VALUES ($1,$2,'Trailblazer','orders_api',1)`,
        [a, prod[0]!.id],
      )
      await pool.query(
        `INSERT INTO landing_revenue_daily (account_id, date, landing_url, currency) VALUES ($1,'2026-08-01','/collections/trail','GBP')`,
        [a],
      )
      await pool.query(
        `INSERT INTO store_pages (account_id, url, page_type) VALUES ($1,'/collections/trail','collection')`,
        [a],
      )

      await pool.query('DELETE FROM accounts WHERE id = $1', [a])

      for (const table of [
        'product_families',
        'products',
        'product_facts',
        'top_products',
        'landing_revenue_daily',
        'store_pages',
      ]) {
        const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${table}`)
        expect(rows[0].n, `${table} should cascade`).toBe(0)
      }
    })

    it('cascades opportunity children when the opportunity goes', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO opportunities
           (account_id, signal_type, entity_type, entity_ref, evidence_json, impact,
            impact_score, confidence, reason_template_key, recommended_action, rules_version)
         VALUES ($1,'existing_page_intent_gap','url','/collections/trail','[]'::jsonb,'medium',
            50,60,'intent_gap.default','optimize','abc') RETURNING id`,
        [a],
      )
      const opportunityId = rows[0]!.id
      await pool.query(
        `INSERT INTO opportunity_tasks (opportunity_id, kind, description) VALUES ($1,'title_rewrite','Rewrite the title')`,
        [opportunityId],
      )
      await pool.query(
        `INSERT INTO optimize_recommendations (opportunity_id, page_url, recommendation_json, prompt_version, model_id, rules_version)
         VALUES ($1,'/collections/trail','{}'::jsonb,'optimize.v1','claude-sonnet-5','abc')`,
        [opportunityId],
      )

      await pool.query('DELETE FROM opportunities WHERE id = $1', [opportunityId])
      for (const table of ['opportunity_tasks', 'optimize_recommendations']) {
        const { rows: after } = await pool.query(`SELECT count(*)::int AS n FROM ${table}`)
        expect(after[0].n, `${table} should cascade`).toBe(0)
      }
    })
  })
})

describe('database availability (wave 2)', () => {
  it('reports whether the constraint suite actually ran', () => {
    if (!available) {
      throw new Error(
        `No Postgres at the test URL. Constraint tests cannot be skipped silently — run \`pnpm db:up\` first.`,
      )
    }
    expect(available).toBe(true)
  })
})
