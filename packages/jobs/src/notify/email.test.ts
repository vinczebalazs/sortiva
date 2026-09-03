import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import type pg from 'pg'
import { accountAttribution, EmailSendFailure, monthlySummaryContent } from '@sortiva/core'
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
import { monthlySummaryFacts } from './assembler'
import { sweepExportUrlReminders } from './export-url-reminder'

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

    it('cannot roll back the decision it was reporting when the mail fails to queue', async () => {
      // Postgres aborts a whole transaction on any failed statement, so a
      // caught error is only survivable inside a savepoint. Without one, the
      // gate decision or publish this notification reports would be rolled back
      // by a failure to write an email row — the opposite of what catching it is
      // for. A trigger is the only reliable way to make that insert fail.
      await pool.query(`
        CREATE FUNCTION refuse_email() RETURNS trigger AS $$
          BEGIN RAISE EXCEPTION 'the mail could not be queued'; END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER refuse_email BEFORE INSERT ON email_sends
          FOR EACH ROW EXECUTE FUNCTION refuse_email();
      `)

      try {
        await ctx.db.transaction(async (tx) => {
          await emitter
            .inTransaction(tx)
            .emit('payment_failed', {}, 'sub-1', accountAttribution(accountId))
          // Stands in for the state change the notification reports, written
          // after it. In an aborted transaction every statement fails, so this
          // succeeding is the proof.
          await tx.execute(sql`select 1`)
        })
      } finally {
        await pool.query('DROP TRIGGER refuse_email ON email_sends')
        await pool.query('DROP FUNCTION refuse_email()')
      }

      const { rows: bell } = await pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM notifications WHERE account_id = $1',
        [accountId],
      )
      expect(bell[0]!.n).toBe(1)
      expect(await emailRows()).toHaveLength(0)
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

  describe('the month the summary reports', () => {
    const PERIOD = '2026-08'
    const inAugust = (day: number) => `2026-08-${String(day).padStart(2, '0')}T10:00:00Z`

    /** A topic, with the opportunity every topic is required to name. */
    const aTopic = async (title: string, forAccount = accountId): Promise<string> => {
      const { rows: opportunity } = await pool.query<{ id: string }>(
        `INSERT INTO opportunities
           (account_id, signal_type, entity_type, entity_ref, evidence_json, impact,
            impact_score, confidence, reason_template_key, recommended_action, rules_version)
         VALUES ($1,'uncovered_commercial_query','query_cluster',$2,'[]'::jsonb,'high',
            80, 70, 'uncovered_commercial_query.default', 'create', 'abc123')
         RETURNING id`,
        [forAccount, `cluster:${title}`],
      )
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO topics (account_id, opportunity_id, title, intent_class, source, scheduled_date)
         VALUES ($1,$2,$3,'buying_guide','auto','2026-08-10')
         RETURNING id`,
        [forAccount, opportunity[0]!.id, title],
      )
      return rows[0]!.id
    }

    const publishArticle = async (title: string, publishedAt: string, forAccount = accountId) => {
      const topicId = await aTopic(title, forAccount)
      await pool.query(
        `INSERT INTO articles (account_id, topic_id, title, slug, state, published_at)
         VALUES ($1,$2,$3,$3,'published',$4)`,
        [forAccount, topicId, title, publishedAt],
      )
    }

    const holdTopic = async (title: string, gate: number, decidedAt: string) => {
      const topicId = await aTopic(title)
      await pool.query(`UPDATE topics SET state = 'rejected_by_gate' WHERE id = $1`, [topicId])
      await pool.query(
        `INSERT INTO gate_decisions
           (account_id, topic_id, gate, outcome, reason_user_facing, decided_at)
         VALUES ($1,$2,$3,'held','gate.reason',$4)`,
        [accountId, topicId, gate, decidedAt],
      )
    }

    const facts = (forAccount = accountId) =>
      monthlySummaryFacts({ getDb: () => ctx.db }, forAccount, PERIOD)

    const readOut = async (forAccount = accountId) => {
      const { text } = await new ReactEmailRenderer().render(
        monthlySummaryContent(await facts(forAccount), {
          dashboardUrl: 'https://sortiva.app/dashboard',
          unsubscribeUrl: 'https://sortiva.app/u?t=tok',
        }),
      )
      return text
    }

    it('names what went live and what the quality bar stopped', async () => {
      await publishArticle('Choosing a wool blanket', inAugust(4))
      await holdTopic('Merino care, step by step', 3, inAugust(12))

      const august = await facts()
      expect(august.articlesPublished).toBe(1)
      expect(august.heldBack).toEqual([
        { title: 'Merino care, step by step', reasonKey: 'email.monthlySummary.heldReason.gate3' },
      ])

      const text = await readOut()
      expect(text).toContain('One article went live on your store.')
      expect(text).toContain('Merino care, step by step')
      expect(text).toContain("The draft didn't clear our quality bar")
    })

    it('says the same month was quiet when it was, rather than reporting nothing at all', async () => {
      const august = await facts()
      expect(august.articlesPublished).toBe(0)
      expect(august.heldBack).toEqual([])

      const text = await readOut()
      expect(text).toContain('Nothing went live this month.')
      expect(text).toContain('Nothing was held back this month.')
    })

    it('counts only the month it is reporting on', async () => {
      await publishArticle('Published in July', '2026-07-30T10:00:00Z')
      await publishArticle('Published in September', '2026-09-02T10:00:00Z')
      expect((await facts()).articlesPublished).toBe(0)
    })

    it("cannot see another store's month", async () => {
      const other = await insertAccount(pool, 'neighbour@example.com')
      await publishArticle('Their article', inAugust(4), other)

      expect((await facts()).articlesPublished).toBe(0)
      expect((await facts(other)).articlesPublished).toBe(1)
    })

    it('names the gate that stopped each topic, so the sentence is true of it', async () => {
      await holdTopic('Never worth writing', 1, inAugust(2))
      await holdTopic('Nothing to write from', 2, inAugust(3))

      const reasons = (await facts()).heldBack.map((topic) => topic.reasonKey).sort()
      expect(reasons).toEqual([
        'email.monthlySummary.heldReason.gate1',
        'email.monthlySummary.heldReason.gate2',
      ])
    })
  })

  describe('the seven-day export-URL reminder', () => {
    const daysAgo = (days: number) =>
      new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

    const anExport = async (
      slug: string,
      publishedAt: string,
      overrides: { delivery?: string; publishedUrl?: string } = {},
    ) => {
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
         VALUES ($1,$2,$3,'buying_guide','auto','2026-10-01') RETURNING id`,
        [accountId, opportunity[0]!.id, slug],
      )
      await pool.query(
        `INSERT INTO articles
           (account_id, topic_id, title, slug, state, delivery, published_url, published_at)
         VALUES ($1,$2,$3,$3,'published',$4,$5,$6)`,
        [
          accountId,
          topic[0]!.id,
          slug,
          overrides.delivery ?? 'export',
          overrides.publishedUrl ?? null,
          publishedAt,
        ],
      )
    }

    const sweep = () => sweepExportUrlReminders({ getDb: () => ctx.db, notifications: emitter })

    it('asks once about an article published with no address, and never again', async () => {
      await anExport('exported-long-ago', daysAgo(9))

      expect(await sweep()).toEqual({ considered: 1, notified: 1 })
      // The second run finds the same article; the unique triple refuses the
      // insert, which is what makes an hourly sweep safe to run hourly.
      expect(await sweep()).toEqual({ considered: 1, notified: 0 })

      const { rows } = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM notifications
          WHERE account_id = $1 AND type = 'export_url_reminder'`,
        [accountId],
      )
      expect(rows[0]!.n).toBe(1)
      expect(await emailRows()).toEqual([
        expect.objectContaining({ type: 'export_url_reminder', state: 'queued' }),
      ])
    })

    it('leaves alone a recent export, one already confirmed, and an auto-published article', async () => {
      await anExport('published-yesterday', daysAgo(1))
      await anExport('already-confirmed', daysAgo(9), {
        publishedUrl: 'https://shop.example/blog/a',
      })
      await anExport('auto-published', daysAgo(9), { delivery: 'auto' })

      expect(await sweep()).toEqual({ considered: 0, notified: 0 })
    })
  })

})
