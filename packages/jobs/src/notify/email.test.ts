import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { accountAttribution, EmailSendFailure } from '@sortiva/core'
import { makeEmailStore } from '@sortiva/db'
import {
  databaseAvailable,
  insertAccount,
  setupTestDb,
  TEST_DATABASE_URL,
  truncateAll,
  type TestDb,
} from '@sortiva/db/testing'
import { makeWorkerUtils, type WorkerUtils } from 'graphile-worker'
import { MockEmailProvider } from '@sortiva/providers'
import { ReactEmailRenderer } from '@sortiva/providers/email/render'
import { DbNotificationEmitter } from './emitter'
import { sweepOauthReminders } from '../ingestion/reminder'
import { drainEmailQueue, runEmailSend, type EmailWorkerDeps } from './send-worker'
import { localClock, periodCovered, sweepMonthlySummaries } from './monthly-summary'

/**
 * The email pipeline against a real Postgres, because every property that
 * matters here is the database's to hold: the unique triple that makes a sweep
 * idempotent, the guarded settle that makes a redelivered job a no-op, and the
 * suppression list that stops mail to an address that bounced.
 */

const available = await databaseAvailable()

const ADDRESS = 'merchant@example.com'
const SECRET = 'unsubscribe-signing-secret'

describe.skipIf(!available)('the email pipeline', () => {
  let ctx: TestDb
  let pool: pg.Pool
  let accountId: string
  let emitter: DbNotificationEmitter
  let provider: MockEmailProvider
  let deps: EmailWorkerDeps
  let utils: WorkerUtils

  beforeAll(async () => {
    ctx = await setupTestDb('jobs_email')
    pool = ctx.pool
    emitter = new DbNotificationEmitter(ctx.db)
    // The queue's own tables are installed by the worker rather than by our
    // migrations, and two of these cases assert on what actually reached it.
    const url = new URL(TEST_DATABASE_URL)
    url.pathname = `/${ctx.databaseName}`
    utils = await makeWorkerUtils({ connectionString: url.toString() })
  })

  afterAll(async () => {
    await utils?.release()
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(pool)
    await pool.query('TRUNCATE graphile_worker._private_jobs CASCADE')
    accountId = await insertAccount(pool, ADDRESS)
    provider = new MockEmailProvider()
    deps = {
      getDb: () => ctx.db,
      getPool: () => pool,
      provider,
      renderer: new ReactEmailRenderer(),
      assembler: { unsubscribeSecret: SECRET, appUrl: 'https://sortiva.app' },
    }
  })

  const emailRows = async () => {
    const { rows } = await pool.query<{ type: string; state: string; template_version: string }>(
      'SELECT type, state, template_version FROM email_sends WHERE account_id = $1 ORDER BY queued_at',
      [accountId],
    )
    return rows
  }

  describe('an hourly sweep run twice sends once', () => {
    it('queues one email for the Shopify connect reminder however often it runs', async () => {
      // The sweep is deliberately safe to run every hour: a merchant who
      // connects in the meantime simply stops matching, and one who has not
      // must not be chased hourly.
      await pool.query(
        `INSERT INTO domains (account_id, domain_normalized, platform, state, updated_at)
         VALUES ($1, 'example.com', 'shopify', 'awaiting_shopify_auth', now() - interval '48 hours')`,
        [accountId],
      )

      const first = await sweepOauthReminders(ctx.db, emitter, new Date())
      const second = await sweepOauthReminders(ctx.db, emitter, new Date())

      expect(first.notified).toBe(1)
      expect(second.notified).toBe(0)

      const rows = await emailRows()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        type: 'oauth_reminder',
        state: 'queued',
        template_version: 'notice.v1',
      })

      const { rows: bell } = await pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM notifications WHERE account_id = $1',
        [accountId],
      )
      expect(bell[0]!.n).toBe(1)
    })

    it('sends one monthly summary however many hours match', async () => {
      const clock = localClock(new Date(), 'UTC')
      const at = new Date(Date.UTC(clock.year, clock.month - 1, 1, 8, 0, 0))
      const run = () =>
        sweepMonthlySummaries({ getDb: () => ctx.db, notifications: emitter, now: () => at })

      expect((await run()).notified).toBe(1)
      expect((await run()).notified).toBe(0)

      const rows = await emailRows()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        type: 'monthly_summary_ready',
        template_version: 'monthly-summary.v1',
      })

      const { rows: keys } = await pool.query<{ dedupe_key: string }>(
        'SELECT dedupe_key FROM email_sends WHERE account_id = $1',
        [accountId],
      )
      expect(keys[0]!.dedupe_key).toBe(periodCovered(localClock(at, 'UTC')))
    })
  })

  describe('who gets an email at all', () => {
    it('writes no email for a kind the monthly summary carries', async () => {
      await emitter.emit('new_opportunities_found', {}, '2026-W35', accountAttribution(accountId))
      expect(await emailRows()).toHaveLength(0)
    })

    it('holds the per-article email until the merchant asks for one', async () => {
      await emitter.emit('article_published', { article_id: 'a-1' }, 'a-1', accountAttribution(accountId))
      expect(await emailRows()).toHaveLength(0)

      await makeEmailStore({ database: ctx.db }).savePreferences(accountId, {
        emailArticlePublished: true,
        emailDigestFrequency: 'weekly',
      })
      await emitter.emit('article_published', { article_id: 'a-2' }, 'a-2', accountAttribution(accountId))
      expect(await emailRows()).toHaveLength(1)
    })

    it('records a suppressed address instead of mailing it', async () => {
      await pool.query(`INSERT INTO email_suppressions (email, reason) VALUES ($1, 'bounced')`, [
        ADDRESS,
      ])
      await emitter.emit('payment_failed', {}, 'sub-1', accountAttribution(accountId))

      const rows = await emailRows()
      expect(rows).toEqual([
        expect.objectContaining({ type: 'payment_failed', state: 'suppressed' }),
      ])

      // And the drain never touches it, because it only reads `queued`.
      expect((await drainEmailQueue(deps)).queued).toBe(0)
    })
  })

  describe('sending', () => {
    const queueOne = async () => {
      await emitter.emit('payment_failed', {}, 'sub-1', accountAttribution(accountId))
      const { rows } = await pool.query<{ id: string }>(
        'SELECT id FROM email_sends WHERE account_id = $1',
        [accountId],
      )
      return rows[0]!.id
    }

    it('sends it once, and a redelivered job sends nothing', async () => {
      const id = await queueOne()

      expect(await runEmailSend(deps, { emailSendId: id })).toEqual({ status: 'sent' })
      expect(await runEmailSend(deps, { emailSendId: id })).toEqual({
        status: 'skipped',
        reason: 'already_settled',
      })

      expect(provider.sent).toHaveLength(1)
      expect(provider.sent[0]!.to).toBe(ADDRESS)
      expect(provider.sent[0]!.idempotencyKey).toBe(`${accountId}:payment_failed:sub-1`)
      expect(provider.sent[0]!.subject).toBe('Your last payment did not go through')
      expect((await emailRows())[0]).toMatchObject({ state: 'sent' })
    })

    it('schedules another attempt on a vendor fault and leaves the row queued', async () => {
      const id = await queueOne()
      provider.failNext(new EmailSendFailure(true, 'email_rate_limit_exceeded', 'slow down'))

      const outcome = await runEmailSend(deps, { emailSendId: id })
      expect(outcome.status).toBe('retry_scheduled')
      expect((await emailRows())[0]).toMatchObject({ state: 'queued' })
    })

    it('dead-letters with a replayable key once the attempts are spent', async () => {
      const id = await queueOne()
      provider.failNext(new EmailSendFailure(true, 'email_rate_limit_exceeded', 'slow down'))

      const outcome = await runEmailSend(deps, { emailSendId: id, attempt: 4 })
      expect(outcome).toMatchObject({ status: 'dead_lettered' })
      expect((await emailRows())[0]).toMatchObject({ state: 'failed' })

      const { rows } = await pool.query<{ idempotency_key: string; step: string; attempts: number }>(
        'SELECT idempotency_key, step, attempts FROM job_dlq WHERE account_id = $1',
        [accountId],
      )
      expect(rows[0]).toMatchObject({
        idempotency_key: `${accountId}:payment_failed:sub-1`,
        step: 'email_send',
        attempts: 4,
      })
    })

    it('turns every queued row into a job, and running the sweep twice queues no duplicate', async () => {
      await queueOne()
      expect((await drainEmailQueue(deps)).queued).toBe(1)
      await drainEmailQueue(deps)

      const { rows } = await pool.query<{ n: number }>(
        `select count(*)::int as n
           from graphile_worker._private_jobs as j
           join graphile_worker._private_tasks as t on t.id = j.task_id
          where t.identifier = 'email_send'`,
      )
      expect(rows[0]!.n).toBe(1)
    })
  })
})
