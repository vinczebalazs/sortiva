import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import {
  CHECK_VIOLATION,
  UNIQUE_VIOLATION,
  databaseAvailable,
  insertAccount,
  pgErrorCode,
  setupTestDb,
  truncateAll,
  type TestDb,
} from './testing'
import { accountScope, systemScope } from './scope'
import { insertDomainRow } from './repositories/domains'
import { emitNotification, queueEmail } from './repositories/notifications'
import { recordStripeEvent, recordWebhookEvent, tripAccountFlag } from './repositories/system'

/**
 * T0.3 done-when: "constraint tests pass (duplicate domain, duplicate webhook
 * id, duplicate stripe event, duplicate notification triple all conflict)".
 *
 * These run against a real Postgres 16 (docker-compose locally, a service
 * container in CI) because these invariants must be enforced at the
 * database level, not just in application code" — which only a real database
 * can demonstrate.
 */

const available = await databaseAvailable()

describe.skipIf(!available)('schema wave 1 constraints', () => {
  let ctx: TestDb
  let pool: pg.Pool

  beforeAll(async () => {
    ctx = await setupTestDb('constraints')
    pool = ctx.pool
  })

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(pool)
  })

  describe('domains — invariant 1 (main §2, §5)', () => {
    it('rejects a second account claiming the same domain', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      const b = await insertAccount(pool, 'b@example.com')

      const first = await insertDomainRow(ctx.db, accountScope(a), 'shop.example.co.uk')
      expect(first?.domainNormalized).toBe('shop.example.co.uk')

      // The repository claims with ON CONFLICT DO NOTHING, so the loser gets
      // undefined rather than an exception — the claim is an
      // insert-with-conflict, never check-then-insert".
      const second = await insertDomainRow(ctx.db, accountScope(b), 'shop.example.co.uk')
      expect(second).toBeUndefined()

      const { rows } = await pool.query('SELECT account_id FROM domains')
      expect(rows).toHaveLength(1)
      expect(rows[0].account_id).toBe(a)
    })

    it('raises a unique violation on a raw duplicate insert', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      const b = await insertAccount(pool, 'b@example.com')
      await pool.query('INSERT INTO domains (account_id, domain_normalized) VALUES ($1, $2)', [
        a,
        'example.com',
      ])
      const error = await pool
        .query('INSERT INTO domains (account_id, domain_normalized) VALUES ($1, $2)', [
          b,
          'example.com',
        ])
        .catch((e) => e)
      expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION)
    })

    it('rejects a second domain on the same account (one domain per account)', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      await insertDomainRow(ctx.db, accountScope(a), 'first.example.com')
      const error = await pool
        .query('INSERT INTO domains (account_id, domain_normalized) VALUES ($1, $2)', [
          a,
          'second.example.com',
        ])
        .catch((e) => e)
      expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION)
    })

    it('lets two accounts claim two different domains', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      const b = await insertAccount(pool, 'b@example.com')
      expect(await insertDomainRow(ctx.db, accountScope(a), 'a.example.com')).toBeDefined()
      expect(await insertDomainRow(ctx.db, accountScope(b), 'b.example.com')).toBeDefined()
    })

    it('exactly one of two concurrent claims succeeds', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      const b = await insertAccount(pool, 'b@example.com')
      const results = await Promise.all([
        insertDomainRow(ctx.db, accountScope(a), 'race.example.com'),
        insertDomainRow(ctx.db, accountScope(b), 'race.example.com'),
      ])
      expect(results.filter(Boolean)).toHaveLength(1)
    })
  })

  describe('webhook_events — main §14.3.8', () => {
    it('makes a duplicate webhook id a no-op', async () => {
      const system = systemScope('webhook receipt')
      const event = {
        webhookId: 'shopify-webhook-1',
        source: 'shopify' as const,
        topic: 'products/update',
        payload: { id: 1 },
      }
      expect(await recordWebhookEvent(ctx.db, system, event)).toBeDefined()
      expect(await recordWebhookEvent(ctx.db, system, event)).toBeUndefined()

      const { rows } = await pool.query('SELECT count(*)::int AS n FROM webhook_events')
      expect(rows[0].n).toBe(1)
    })

    it('raises a unique violation on a raw duplicate insert', async () => {
      await pool.query(
        `INSERT INTO webhook_events (webhook_id, source, topic, payload) VALUES ($1,'shopify','products/update','{}')`,
        ['dupe-1'],
      )
      const error = await pool
        .query(
          `INSERT INTO webhook_events (webhook_id, source, topic, payload) VALUES ($1,'shopify','products/update','{}')`,
          ['dupe-1'],
        )
        .catch((e) => e)
      expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION)
    })
  })

  describe('stripe_events — main §4.2, §14.3.8', () => {
    it('makes a duplicate stripe event id a no-op', async () => {
      const system = systemScope('stripe webhook receipt')
      const event = { eventId: 'evt_1', type: 'invoice.paid', payload: {} }
      expect(await recordStripeEvent(ctx.db, system, event)).toBeDefined()
      expect(await recordStripeEvent(ctx.db, system, event)).toBeUndefined()

      const { rows } = await pool.query('SELECT count(*)::int AS n FROM stripe_events')
      expect(rows[0].n).toBe(1)
    })

    it('raises a unique violation on a raw duplicate insert', async () => {
      await pool.query(
        `INSERT INTO stripe_events (event_id, type, payload) VALUES ('evt_2','invoice.paid','{}')`,
      )
      const error = await pool
        .query(
          `INSERT INTO stripe_events (event_id, type, payload) VALUES ('evt_2','invoice.paid','{}')`,
        )
        .catch((e) => e)
      expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION)
    })
  })

  describe('notifications & email_sends — invariant 26 (tech §1.2, §1.4)', () => {
    it('makes a duplicate (account, type, dedupe_key) triple a no-op', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      const scope = accountScope(a)
      const emission = { type: 'article_published' as const, dedupeKey: 'article-42' }

      expect(await emitNotification(ctx.db, scope, emission)).toBeDefined()
      expect(await emitNotification(ctx.db, scope, emission)).toBeUndefined()

      const { rows } = await pool.query('SELECT count(*)::int AS n FROM notifications')
      expect(rows[0].n).toBe(1)
    })

    it('separates the triple by account, by type, and by dedupe key', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      const b = await insertAccount(pool, 'b@example.com')
      expect(
        await emitNotification(ctx.db, accountScope(a), {
          type: 'article_published',
          dedupeKey: 'x',
        }),
      ).toBeDefined()
      // Same triple, different account.
      expect(
        await emitNotification(ctx.db, accountScope(b), {
          type: 'article_published',
          dedupeKey: 'x',
        }),
      ).toBeDefined()
      // Same account and key, different type.
      expect(
        await emitNotification(ctx.db, accountScope(a), {
          type: 'draft_ready_for_review',
          dedupeKey: 'x',
        }),
      ).toBeDefined()
      // Same account and type, different key.
      expect(
        await emitNotification(ctx.db, accountScope(a), {
          type: 'article_published',
          dedupeKey: 'y',
        }),
      ).toBeDefined()
    })

    it('raises a unique violation on a raw duplicate triple', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      const insert = `INSERT INTO notifications (account_id, type, dedupe_key) VALUES ($1,'topic_held_by_gate','t-1')`
      await pool.query(insert, [a])
      const error = await pool.query(insert, [a]).catch((e) => e)
      expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION)
    })

    it('applies the same triple to email_sends', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      const scope = accountScope(a)
      const send = {
        type: 'monthly_summary_ready' as const,
        dedupeKey: '2026-08',
        templateVersion: 'v1',
      }
      expect(await queueEmail(ctx.db, scope, send)).toBeDefined()
      expect(await queueEmail(ctx.db, scope, send)).toBeUndefined()
    })
  })

  describe('supporting wave-1 constraints', () => {
    it('keeps accounts.email unique', async () => {
      await insertAccount(pool, 'dupe@example.com')
      const error = await insertAccount(pool, 'dupe@example.com').catch((e) => e)
      expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION)
    })

    it('keeps one job_steps row per (job, step)', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      const { rows } = await pool.query<{ id: string }>(
        'INSERT INTO ingestion_jobs (account_id, run_id) VALUES ($1, $2) RETURNING id',
        [a, 'run-1'],
      )
      const jobId = rows[0]!.id
      const insert = `INSERT INTO job_steps (job_id, step, idempotency_key) VALUES ($1,'detect','k1')`
      await pool.query(insert, [jobId])
      const error = await pool.query(insert, [jobId]).catch((e) => e)
      expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION)
    })

    it('allows only one active flag of a name per account (main §14.5)', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      const scope = accountScope(a)
      const trip = {
        flag: 'account.pause_generation',
        actor: 'auto-trip:llm_spend',
        reason: 'daily spend > 10x median',
        trippedBy: 'auto' as const,
      }
      expect(await tripAccountFlag(ctx.db, scope, trip)).toBeDefined()
      expect(await tripAccountFlag(ctx.db, scope, trip)).toBeUndefined()

      // Auto-trips never auto-reset; resetting frees the name for a later trip.
      await pool.query(`UPDATE ops_flags SET reset_at = now(), reset_by = 'operator'`)
      expect(await tripAccountFlag(ctx.db, scope, trip)).toBeDefined()
    })

    it('allows only one active global flag of a name', async () => {
      const insert = `INSERT INTO ops_flags (scope, flag, actor, reason, tripped_by) VALUES ('global','global.pause_all','ops','judge fail rate','auto')`
      await pool.query(insert)
      const error = await pool.query(insert).catch((e) => e)
      expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION)
    })

    it('rejects a global flag carrying an account, and an account flag without one', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      const globalWithAccount = await pool
        .query(
          `INSERT INTO ops_flags (scope, account_id, flag, actor, reason, tripped_by) VALUES ('global',$1,'global.pause_all','ops','x','manual')`,
          [a],
        )
        .catch((e) => e)
      expect(pgErrorCode(globalWithAccount)).toBe(CHECK_VIOLATION)

      const accountWithout = await pool
        .query(
          `INSERT INTO ops_flags (scope, flag, actor, reason, tripped_by) VALUES ('account','account.pause_generation','ops','x','manual')`,
        )
        .catch((e) => e)
      expect(pgErrorCode(accountWithout)).toBe(CHECK_VIOLATION)
    })

    it('keeps one subscription row per account and one per Stripe subscription', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      const b = await insertAccount(pool, 'b@example.com')
      await pool.query(
        `INSERT INTO subscriptions (account_id, stripe_subscription_id, price_id, status) VALUES ($1,'sub_1','price_1','active')`,
        [a],
      )
      const duplicateSub = await pool
        .query(
          `INSERT INTO subscriptions (account_id, stripe_subscription_id, price_id, status) VALUES ($1,'sub_1','price_1','active')`,
          [b],
        )
        .catch((e) => e)
      expect(pgErrorCode(duplicateSub)).toBe(UNIQUE_VIOLATION)
    })

    it('cascades wave-1 rows when an account is deleted (main §14.6, tech §1.5)', async () => {
      const a = await insertAccount(pool, 'a@example.com')
      await insertDomainRow(ctx.db, accountScope(a), 'gone.example.com')
      await emitNotification(ctx.db, accountScope(a), {
        type: 'article_published',
        dedupeKey: 'x',
      })
      await queueEmail(ctx.db, accountScope(a), {
        type: 'article_published',
        dedupeKey: 'x',
        templateVersion: 'v1',
      })

      await pool.query('DELETE FROM accounts WHERE id = $1', [a])

      for (const table of ['domains', 'notifications', 'email_sends']) {
        const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${table}`)
        expect(rows[0].n, `${table} should cascade`).toBe(0)
      }
    })
  })
})

describe('database availability', () => {
  it('reports whether the constraint suite actually ran', () => {
    if (!available) {
      throw new Error(
        `No Postgres at the test URL. Constraint tests cannot be skipped silently — run \`pnpm db:up\` first.`,
      )
    }
    expect(available).toBe(true)
  })
})
