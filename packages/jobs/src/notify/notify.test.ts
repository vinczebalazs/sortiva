import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import {
  accountAttribution,
  attentionSourcesFor,
  buildAttentionList,
  notificationFeed,
} from '@sortiva/core'
import { makeNotificationStore } from '@sortiva/db'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { DbNotificationEmitter } from './emitter'

/**
 * The two properties the bell and the attention list are built on, against a
 * real Postgres, because both of them are the database's to hold.
 *
 *  1. A job the queue delivers twice notifies once. The unique triple is what
 *     enforces it; a second insert is a no-op rather than an error the caller
 *     has to catch and interpret.
 *  2. An attention item is a query result and never a row, so resolving the
 *     underlying condition removes it and writes nothing.
 */

const available = await databaseAvailable()

describe.skipIf(!available)('notifications and the attention list', () => {
  let ctx: TestDb
  let pool: pg.Pool
  let accountId: string
  let store: ReturnType<typeof makeNotificationStore>
  let emitter: DbNotificationEmitter

  beforeAll(async () => {
    ctx = await setupTestDb('jobs_notify')
    pool = ctx.pool
    store = makeNotificationStore({ database: ctx.db })
    emitter = new DbNotificationEmitter(ctx.db)
  })

  afterAll(async () => {
    await ctx.close()
  })

  beforeEach(async () => {
    await truncateAll(pool)
    accountId = await insertAccount(pool, 'merchant@example.com')
  })

  const attribution = () => accountAttribution(accountId)

  describe('a retried publish job rings the bell once', () => {
    it('creates on the first attempt and no-ops on the second', async () => {
      const first = await emitter.emit(
        'article_published',
        { article_id: '0f8fad5b-d9cb-469f-a165-70867728950e' },
        '0f8fad5b-d9cb-469f-a165-70867728950e',
        attribution(),
      )
      const retry = await emitter.emit(
        'article_published',
        { article_id: '0f8fad5b-d9cb-469f-a165-70867728950e' },
        '0f8fad5b-d9cb-469f-a165-70867728950e',
        attribution(),
      )

      expect([first.created, retry.created]).toEqual([true, false])

      const { rows } = await pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM notifications WHERE account_id = $1',
        [accountId],
      )
      expect(rows[0]!.n).toBe(1)
    })

    it('still rings for a different article, which is the point of keying on one', async () => {
      await emitter.emit('article_published', { article_id: 'a-1' }, 'a-1', attribution())
      await emitter.emit('article_published', { article_id: 'a-2' }, 'a-2', attribution())

      const feed = await notificationFeed(store, accountId)
      expect(feed.notifications).toHaveLength(2)
      expect(feed.unseenCount).toBe(2)
    })

    it('refuses to store words, so a headline cannot outlive its article', async () => {
      await expect(
        emitter.emit(
          'article_published',
          { title: 'How to store a wool coat' },
          'a-3',
          attribution(),
        ),
      ).rejects.toThrow(/is not a reference/i)

      const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM notifications')
      expect(rows[0]!.n).toBe(0)
    })

    it('refuses an empty dedupe key rather than ringing twice later', async () => {
      await expect(
        emitter.emit('article_published', { article_id: 'a-4' }, '', attribution()),
      ).rejects.toThrow(/dedupe key/i)
    })

    it('commits with the state change when handed a transaction, and rolls back with it', async () => {
      await ctx.db
        .transaction(async (tx) => {
          await emitter.inTransaction(tx).emit(
            'topic_held_by_gate',
            { topic_id: 't-1' },
            't-1',
            attribution(),
          )
          throw new Error('the gate decision failed to write')
        })
        .catch(() => undefined)

      // Nobody is told about a decision that was rolled back.
      const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM notifications')
      expect(rows[0]!.n).toBe(0)
    })
  })

  describe('seen and read are two different claims', () => {
    it('clears the badge without marking anything read', async () => {
      await emitter.emit('article_published', { article_id: 'a-1' }, 'a-1', attribution())

      expect((await notificationFeed(store, accountId)).unseenCount).toBe(1)
      await store.markSeen(accountId)

      const feed = await notificationFeed(store, accountId)
      expect(feed.unseenCount).toBe(0)
      expect(feed.notifications[0]!.readAt).toBeNull()
      expect(feed.notifications[0]!.seenAt).not.toBeNull()
    })

    it('marks one item read', async () => {
      await emitter.emit('article_published', { article_id: 'a-1' }, 'a-1', attribution())
      const [item] = (await notificationFeed(store, accountId)).notifications

      expect(await store.markRead(accountId, item!.id)).toBe(true)
      expect((await notificationFeed(store, accountId)).notifications[0]!.readAt).not.toBeNull()
    })

    it("answers another account's notification exactly as it answers a missing one", async () => {
      const other = await insertAccount(pool, 'other@example.com')
      await new DbNotificationEmitter(ctx.db).emit(
        'article_published',
        { article_id: 'a-1' },
        'a-1',
        accountAttribution(other),
      )
      const [theirs] = (await notificationFeed(store, other)).notifications

      expect(await store.markRead(accountId, theirs!.id)).toBe(false)
    })

    it('returns only what arrived since the browser last asked', async () => {
      await emitter.emit('article_published', { article_id: 'a-1' }, 'a-1', attribution())
      // The browser's high-water mark is the newest row it has already seen, not
      // its own clock: the database's clock is the one the rows are stamped with.
      const watermark = (await notificationFeed(store, accountId)).notifications[0]!.createdAt
      await new Promise((resolve) => setTimeout(resolve, 5))
      await emitter.emit('article_published', { article_id: 'a-2' }, 'a-2', attribution())

      const feed = await notificationFeed(store, accountId, { since: watermark })
      expect(feed.notifications.map((n) => n.refs.article_id)).toEqual(['a-2'])
      // The badge is still the whole truth, not the page.
      expect(feed.unseenCount).toBe(2)
    })
  })

  describe('an attention item is a query, so resolving the thing removes it', () => {
    const insertHoldOpportunity = async (): Promise<string> => {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO opportunities
           (account_id, signal_type, entity_type, entity_ref, evidence_json, impact,
            impact_score, confidence, reason_template_key, recommended_action, status, rules_version)
         VALUES ($1,'catalog_richness_gap','product','product:1','[]'::jsonb,'high',
            80, 70, 'catalog_richness_gap.default', 'hold', 'new', 'abc123')
         RETURNING id`,
        [accountId],
      )
      const opportunityId = rows[0]!.id
      await pool.query(
        `INSERT INTO opportunity_tasks (opportunity_id, kind, description, state)
         VALUES ($1,'product_data','Add fabric and care details','open')`,
        [opportunityId],
      )
      return opportunityId
    }

    const list = () => buildAttentionList(attentionSourcesFor(store, accountId))

    it('shows a task that needs the merchant, and drops it when they apply it — with no write of ours', async () => {
      await insertHoldOpportunity()

      const before = await list()
      expect(before.map((item) => item.kind)).toEqual(['merchant_task'])

      const countRows = async () => {
        const { rows } = await pool.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM notifications',
        )
        return rows[0]!.n
      }
      expect(await countRows()).toBe(0)

      // The merchant marks it applied. That is a change to the task, and the
      // only one: nothing writes an attention row, because there is none.
      await pool.query(`UPDATE opportunity_tasks SET state = 'applied', applied_at = now()`)

      expect(await list()).toEqual([])
      expect(await countRows()).toBe(0)
    })

    it('ignores tasks on an opportunity that is no longer live', async () => {
      await insertHoldOpportunity()
      await pool.query(`UPDATE opportunities SET status = 'dismissed'`)
      expect(await list()).toEqual([])
    })

    it('waits out the nudge window before mentioning an unapplied recommendation', async () => {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO opportunities
           (account_id, signal_type, entity_type, entity_ref, evidence_json, impact,
            impact_score, confidence, reason_template_key, recommended_action, status, rules_version)
         VALUES ($1,'striking_distance','url','/collections/coats','[]'::jsonb,'high',
            80, 70, 'striking_distance.default', 'optimize', 'accepted', 'abc123')
         RETURNING id`,
        [accountId],
      )
      const opportunityId = rows[0]!.id
      const insertRecommendation = (generatedAt: string) =>
        pool.query(
          `INSERT INTO optimize_recommendations
             (opportunity_id, page_url, recommendation_json, prompt_version, model_id,
              rules_version, generated_at, state)
           VALUES ($1,'/collections/coats','{}'::jsonb,'v1','model-x','abc123',$2,'valid')`,
          [opportunityId, generatedAt],
        )

      await insertRecommendation(new Date().toISOString())
      expect(await list()).toEqual([])

      await pool.query('DELETE FROM optimize_recommendations')
      await insertRecommendation(new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString())

      const items = await list()
      expect(items.map((item) => item.kind)).toEqual(['optimize_unapplied'])
      expect(items[0]!.refs.opportunity_id).toBe(opportunityId)
    })

    it('stops mentioning it once the merchant marks the opportunity applied', async () => {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO opportunities
           (account_id, signal_type, entity_type, entity_ref, evidence_json, impact,
            impact_score, confidence, reason_template_key, recommended_action, status, rules_version)
         VALUES ($1,'striking_distance','url','/collections/coats','[]'::jsonb,'high',
            80, 70, 'striking_distance.default', 'optimize', 'accepted', 'abc123')
         RETURNING id`,
        [accountId],
      )
      await pool.query(
        `INSERT INTO optimize_recommendations
           (opportunity_id, page_url, recommendation_json, prompt_version, model_id,
            rules_version, generated_at, state)
         VALUES ($1,'/collections/coats','{}'::jsonb,'v1','model-x','abc123',$2,'valid')`,
        [rows[0]!.id, new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString()],
      )
      expect(await list()).toHaveLength(1)

      await pool.query(`UPDATE opportunities SET applied_at = now()`)
      expect(await list()).toEqual([])
    })

    it('sees nothing for another account', async () => {
      await insertHoldOpportunity()
      const other = await insertAccount(pool, 'other@example.com')
      expect(await buildAttentionList(attentionSourcesFor(store, other))).toEqual([])
    })
  })
})
