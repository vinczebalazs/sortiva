import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from './testing'

/**
 * Card T1.2a's migration (`0006_billing_remediation.sql`).
 *
 * Every case talks to a real Postgres, because the two things under test are
 * properties of the database and not of TypeScript: which values the status
 * enum accepts, and that the ordering guard has a column of its own that the
 * staleness clock cannot disturb.
 *
 * The suite fails loudly rather than skipping when no database is reachable —
 * see the final describe block. A silently-skipped constraint suite reports
 * green while proving nothing.
 */

const available = await databaseAvailable()

describe.skipIf(!available)('billing schema, card T1.2a', () => {
  let ctx: TestDb
  let pool: pg.Pool

  beforeAll(async () => {
    ctx = await setupTestDb('constraints_billing')
    pool = ctx.pool
  })

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(pool)
  })

  const addSubscription = (
    accountId: string,
    status: string,
    stateObservedAt: string,
    syncedAt = stateObservedAt,
  ) =>
    pool.query(
      `INSERT INTO subscriptions
         (account_id, stripe_subscription_id, price_id, status, synced_at, state_observed_at)
       VALUES ($1, $2, 'price_m', $3::subscription_status, $4, $5)`,
      [accountId, `sub_${accountId.slice(0, 8)}`, status, syncedAt, stateObservedAt],
    )

  describe('subscription_status — `incomplete` is its own value', () => {
    it('accepts every status the product can store', async () => {
      for (const status of [
        'active',
        'comped',
        'past_due',
        'canceled',
        'incomplete',
        'incomplete_expired',
      ]) {
        const accountId = await insertAccount(pool, `${status}@example.com`)
        await addSubscription(accountId, status, '2026-09-01T00:00:00Z')
        const { rows } = await pool.query(
          'SELECT status FROM subscriptions WHERE account_id = $1',
          [accountId],
        )
        expect(rows[0].status).toBe(status)
      }
    })

    it('stores `incomplete` as itself, not as `incomplete_expired`', async () => {
      // The distinction the migration exists for: a merchant whose first
      // payment is still being authorised is not one who gave up.
      const accountId = await insertAccount(pool, 'mid-purchase@example.com')
      await addSubscription(accountId, 'incomplete', '2026-09-01T00:00:00Z')
      const { rows } = await pool.query(
        `SELECT status FROM subscriptions WHERE account_id = $1`,
        [accountId],
      )
      expect(rows[0].status).toBe('incomplete')
      expect(rows[0].status).not.toBe('incomplete_expired')
    })

    /**
     * A comped account is entitled and has no payment behind it, so the two
     * payment columns have to accept nothing at all. Before card 1 they were
     * both NOT NULL, which is what made "free store" unrepresentable.
     */
    it('stores a comped row with no payment columns filled in', async () => {
      const accountId = await insertAccount(pool, 'comped@example.com')
      await pool.query(
        `INSERT INTO subscriptions (account_id, status) VALUES ($1, 'comped')`,
        [accountId],
      )
      const { rows } = await pool.query(
        `SELECT status, stripe_subscription_id, price_id, current_period_end
           FROM subscriptions WHERE account_id = $1`,
        [accountId],
      )
      expect(rows[0]).toMatchObject({
        status: 'comped',
        stripe_subscription_id: null,
        price_id: null,
        current_period_end: null,
      })
    })

    /**
     * The unique index on the payment id has to tolerate more than one row with
     * nothing in that column, or the second comped store could never be created.
     * Postgres allows repeated nulls in a unique index; this asserts it rather
     * than assuming it, because the whole pilot rests on it.
     */
    it('allows a second comped row alongside the first', async () => {
      const first = await insertAccount(pool, 'comped-one@example.com')
      const second = await insertAccount(pool, 'comped-two@example.com')
      await pool.query(`INSERT INTO subscriptions (account_id, status) VALUES ($1, 'comped')`, [first])
      await pool.query(`INSERT INTO subscriptions (account_id, status) VALUES ($1, 'comped')`, [second])
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM subscriptions WHERE status = 'comped'`)
      expect(rows[0].n).toBe(2)
    })

    it('still refuses a status that is not in the enum', async () => {
      const accountId = await insertAccount(pool, 'bogus@example.com')
      await expect(addSubscription(accountId, 'trialing', '2026-09-01T00:00:00Z')).rejects.toThrow()
    })
  })

  describe('the ordering guard has a column of its own', () => {
    it('carries state_observed_at and synced_at independently', async () => {
      const accountId = await insertAccount(pool, 'split@example.com')
      // We contacted Stripe at 12:00 but the state we hold was read at 09:00 —
      // the shape a reconciliation produces when its write loses the race.
      await addSubscription(
        accountId,
        'active',
        '2026-09-01T09:00:00Z',
        '2026-09-01T12:00:00Z',
      )
      const { rows } = await pool.query(
        'SELECT synced_at, state_observed_at FROM subscriptions WHERE account_id = $1',
        [accountId],
      )
      expect(new Date(rows[0].state_observed_at).toISOString()).toBe('2026-09-01T09:00:00.000Z')
      expect(new Date(rows[0].synced_at).toISOString()).toBe('2026-09-01T12:00:00.000Z')
    })

    it('lets the staleness clock advance without moving the ordering floor', async () => {
      const accountId = await insertAccount(pool, 'marksynced@example.com')
      await addSubscription(accountId, 'active', '2026-09-01T09:00:00Z')

      // What `markSynced` does: we reached Stripe, the state did not change.
      await pool.query(
        `UPDATE subscriptions SET synced_at = $2 WHERE account_id = $1`,
        [accountId, '2026-09-02T09:00:00Z'],
      )

      const { rows } = await pool.query(
        'SELECT synced_at, state_observed_at FROM subscriptions WHERE account_id = $1',
        [accountId],
      )
      // The floor must not have moved: if it had, every webhook stamped before
      // 2026-09-02 would now be discarded as stale and the account would freeze.
      expect(new Date(rows[0].state_observed_at).toISOString()).toBe('2026-09-01T09:00:00.000Z')
      expect(new Date(rows[0].synced_at).toISOString()).toBe('2026-09-02T09:00:00.000Z')
    })

    it('the guarded upsert rejects a write carrying an older read', async () => {
      const accountId = await insertAccount(pool, 'guard@example.com')
      await addSubscription(accountId, 'active', '2026-09-01T12:00:00Z')

      // The exact SQL the billing store runs, with an older read time.
      const stale = await pool.query(
        `INSERT INTO subscriptions
           (account_id, stripe_subscription_id, price_id, status, synced_at, state_observed_at)
         VALUES ($1, 'sub_guard', 'price_m', 'past_due'::subscription_status, $2, $2)
         ON CONFLICT (account_id) DO UPDATE SET
           status            = EXCLUDED.status,
           synced_at         = GREATEST(subscriptions.synced_at, EXCLUDED.synced_at),
           state_observed_at = EXCLUDED.state_observed_at
         WHERE subscriptions.state_observed_at <= EXCLUDED.state_observed_at
         RETURNING account_id`,
        [accountId, '2026-09-01T09:00:00Z'],
      )

      expect(stale.rowCount).toBe(0)
      const { rows } = await pool.query(
        'SELECT status FROM subscriptions WHERE account_id = $1',
        [accountId],
      )
      // A late delivery must never roll a newer status back.
      expect(rows[0].status).toBe('active')
    })

    it('the guarded upsert applies a write carrying a newer read', async () => {
      const accountId = await insertAccount(pool, 'guard2@example.com')
      await addSubscription(accountId, 'active', '2026-09-01T09:00:00Z')

      const fresh = await pool.query(
        `INSERT INTO subscriptions
           (account_id, stripe_subscription_id, price_id, status, synced_at, state_observed_at)
         VALUES ($1, 'sub_guard2', 'price_m', 'past_due'::subscription_status, $2, $2)
         ON CONFLICT (account_id) DO UPDATE SET
           status            = EXCLUDED.status,
           synced_at         = GREATEST(subscriptions.synced_at, EXCLUDED.synced_at),
           state_observed_at = EXCLUDED.state_observed_at
         WHERE subscriptions.state_observed_at <= EXCLUDED.state_observed_at
         RETURNING account_id`,
        [accountId, '2026-09-01T12:00:00Z'],
      )

      expect(fresh.rowCount).toBe(1)
      const { rows } = await pool.query(
        'SELECT status FROM subscriptions WHERE account_id = $1',
        [accountId],
      )
      expect(rows[0].status).toBe('past_due')
    })
  })

  describe('the schema says out loud what writing now() would do', () => {
    it('carries a comment on state_observed_at naming the failure', async () => {
      // The failure is silent — no error, no log — so the warning has to live
      // where the next author looks, which is the column itself.
      const { rows } = await pool.query(
        `SELECT col_description(
                  'subscriptions'::regclass,
                  (SELECT attnum FROM pg_attribute
                    WHERE attrelid = 'subscriptions'::regclass
                      AND attname = 'state_observed_at')
                ) AS comment`,
      )
      expect(rows[0].comment).toMatch(/now\(\)/)
      expect(rows[0].comment).toMatch(/stale/i)
    })
  })
})

describe('database availability (billing schema)', () => {
  it('reports whether the constraint suite actually ran', () => {
    if (!available) {
      throw new Error(
        `No Postgres at the test URL. Constraint tests cannot be skipped silently — run \`pnpm db:up\` first.`,
      )
    }
    expect(available).toBe(true)
  })
})
