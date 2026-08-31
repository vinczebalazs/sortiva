import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import {
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
 * Schema mini-wave 2b (`docs/audits/remediation.md` D7).
 *
 * Every case talks to a real Postgres and asserts on the error code the
 * *database* raised, because a constraint asserted in TypeScript is not a
 * constraint. The two properties under test are both structural: a magic link
 * is single-use, and the record of completed work survives everything that can
 * delete a job.
 *
 * The suite fails loudly rather than skipping when no database is reachable —
 * see the final describe block. A silently-skipped constraint suite reports
 * green while proving nothing.
 */

const available = await databaseAvailable()

describe.skipIf(!available)('schema mini-wave 2b constraints', () => {
  let ctx: TestDb
  let pool: pg.Pool

  beforeAll(async () => {
    ctx = await setupTestDb('constraints_wave2b')
    pool = ctx.pool
  })

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(pool)
  })

  describe('verification_tokens — one row per outstanding sign-in link (main §4.1)', () => {
    const addToken = (identifier: string, token: string, minutesAhead = 15) =>
      pool.query(
        `INSERT INTO verification_tokens (identifier, token, expires)
         VALUES ($1, $2, now() + ($3 || ' minutes')::interval)`,
        [identifier, token, String(minutesAhead)],
      )

    it('stores a link and lets the same address hold several at once', async () => {
      await addToken('merchant@example.com', 'tok-1')
      await expect(addToken('merchant@example.com', 'tok-2')).resolves.toBeDefined()

      const { rows } = await pool.query('SELECT count(*)::int AS n FROM verification_tokens')
      expect(rows[0].n).toBe(2)
    })

    it('refuses the same (address, token) twice', async () => {
      await addToken('merchant@example.com', 'tok-1')
      const again = await addToken('merchant@example.com', 'tok-1').catch((e) => e)
      expect(pgErrorCode(again)).toBe(UNIQUE_VIOLATION)
    })

    it('refuses one secret opening two mailboxes', async () => {
      await addToken('merchant@example.com', 'shared-secret')
      const other = await addToken('someone-else@example.com', 'shared-secret').catch((e) => e)
      expect(pgErrorCode(other)).toBe(UNIQUE_VIOLATION)
    })

    it('makes a followed link unusable, because using it deletes the row', async () => {
      await addToken('merchant@example.com', 'tok-1')

      // What Auth.js's `useVerificationToken` does: consume by deletion.
      const first = await pool.query(
        `DELETE FROM verification_tokens WHERE identifier = $1 AND token = $2 RETURNING expires`,
        ['merchant@example.com', 'tok-1'],
      )
      expect(first.rowCount).toBe(1)

      // A forwarded copy, or a mail scanner's prefetch, arrives second.
      const replay = await pool.query(
        `DELETE FROM verification_tokens WHERE identifier = $1 AND token = $2 RETURNING expires`,
        ['merchant@example.com', 'tok-1'],
      )
      expect(replay.rowCount).toBe(0)
    })

    it('has no foreign key, so a link can be issued to an address with no account yet', async () => {
      await expect(addToken('stranger@example.com', 'tok-new')).resolves.toBeDefined()

      const { rows } = await pool.query(
        `SELECT count(*)::int AS n
         FROM information_schema.table_constraints
         WHERE table_name = 'verification_tokens' AND constraint_type = 'FOREIGN KEY'`,
      )
      expect(rows[0].n).toBe(0)
    })

    it('records an expiry the sweep and the adapter can both read', async () => {
      await addToken('merchant@example.com', 'tok-1', -5)
      await addToken('merchant@example.com', 'tok-2', 15)

      const { rows } = await pool.query(
        `SELECT token FROM verification_tokens WHERE expires < now()`,
      )
      expect(rows.map((r) => r.token)).toEqual(['tok-1'])
    })
  })

  describe('idempotency_ledger — the record of completed work outlives the job (main §14.3.2)', () => {
    const recordCompletion = (key: string, outputRef: unknown = { articleId: 'a-1' }) =>
      pool.query(
        `INSERT INTO idempotency_ledger (idempotency_key, output_ref) VALUES ($1, $2::jsonb)`,
        [key, JSON.stringify(outputRef)],
      )

    it('answers "have I done this" and "where is the result" in one lookup', async () => {
      await recordCompletion('sha256:catalog_sync:1', { products: 412 })

      const { rows } = await pool.query(
        `SELECT output_ref, completed_at FROM idempotency_ledger WHERE idempotency_key = $1`,
        ['sha256:catalog_sync:1'],
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].output_ref).toEqual({ products: 412 })
      expect(rows[0].completed_at).toBeInstanceOf(Date)
    })

    it('refuses a second row for the same key', async () => {
      await recordCompletion('sha256:distill:1')
      const again = await recordCompletion('sha256:distill:1', { articleId: 'different' }).catch(
        (e) => e,
      )
      expect(pgErrorCode(again)).toBe(UNIQUE_VIOLATION)
    })

    it('lets a redelivered message re-record its completion as a no-op', async () => {
      await recordCompletion('sha256:distill:1', { articleId: 'a-1' })
      // The shape the worker must use: never an upsert.
      await pool.query(
        `INSERT INTO idempotency_ledger (idempotency_key, output_ref)
         VALUES ($1, $2::jsonb) ON CONFLICT (idempotency_key) DO NOTHING`,
        ['sha256:distill:1', JSON.stringify({ articleId: 'a-2' })],
      )

      const { rows } = await pool.query(
        `SELECT output_ref FROM idempotency_ledger WHERE idempotency_key = $1`,
        ['sha256:distill:1'],
      )
      expect(rows[0].output_ref).toEqual({ articleId: 'a-1' })
    })

    it('refuses to let a stored output be revised', async () => {
      await recordCompletion('sha256:persona:1', { personaId: 'p-1' })
      const revised = await pool
        .query(`UPDATE idempotency_ledger SET output_ref = '{"personaId":"p-2"}'::jsonb`)
        .catch((e) => e)

      expect(pgErrorCode(revised)).toBe(RESTRICT_VIOLATION)
      expect(String(revised.message)).toContain('write-once')
    })

    it('accepts a completion that produced no output', async () => {
      await pool.query(`INSERT INTO idempotency_ledger (idempotency_key) VALUES ('sha256:noop:1')`)
      const { rows } = await pool.query(
        `SELECT output_ref FROM idempotency_ledger WHERE idempotency_key = 'sha256:noop:1'`,
      )
      // Row presence, not the payload, is the answer to "was it done".
      expect(rows).toHaveLength(1)
      expect(rows[0].output_ref).toBeNull()
    })

    it('has no foreign keys at all — the point of the table', async () => {
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n
         FROM information_schema.table_constraints
         WHERE table_name = 'idempotency_ledger' AND constraint_type = 'FOREIGN KEY'`,
      )
      expect(rows[0].n).toBe(0)
    })

    it('survives the deletion of the job that produced it', async () => {
      const accountId = await insertAccount(pool, 'merchant@example.com')
      const { rows: jobRows } = await pool.query<{ id: string }>(
        `INSERT INTO ingestion_jobs (account_id, run_id) VALUES ($1, 'run-1') RETURNING id`,
        [accountId],
      )
      await pool.query(
        `INSERT INTO job_steps (job_id, step, state, idempotency_key, output_ref)
         VALUES ($1, 'catalog_sync', 'succeeded', $2, '{"products":412}'::jsonb)`,
        [jobRows[0]!.id, 'sha256:catalog_sync:1'],
      )
      await recordCompletion('sha256:catalog_sync:1', { products: 412 })

      // A retention sweep, a "restart onboarding" feature, or an account
      // cascade — every path `docs/audits/T0.4.md` traced.
      await pool.query('DELETE FROM job_steps')
      await pool.query('DELETE FROM ingestion_jobs')
      await pool.query('DELETE FROM accounts WHERE id = $1', [accountId])

      const { rows } = await pool.query(
        `SELECT output_ref FROM idempotency_ledger WHERE idempotency_key = 'sha256:catalog_sync:1'`,
      )
      // Without this row the replay would re-run a billed Shopify crawl.
      expect(rows).toHaveLength(1)
      expect(rows[0].output_ref).toEqual({ products: 412 })
    })
  })
})

describe('database availability (mini-wave 2b)', () => {
  it('reports whether the constraint suite actually ran', () => {
    if (!available) {
      throw new Error(
        `No Postgres at the test URL. Constraint tests cannot be skipped silently — run \`pnpm db:up\` first.`,
      )
    }
    expect(available).toBe(true)
  })
})
