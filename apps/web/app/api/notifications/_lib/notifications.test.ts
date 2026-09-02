import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  accountAttribution,
  attentionResponseSchema,
  notificationsResponseSchema,
} from '@sortiva/core'
import { makeNotificationStore } from '@sortiva/db'
import { databaseAvailable, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { DbNotificationEmitter } from '@sortiva/jobs/notify/emitter'
import { withAccount } from '../../auth/_lib/session'
import {
  makeAttentionHandler,
  makeNotificationsHandler,
  makeReadHandler,
  makeSeenHandler,
} from './handlers'

/**
 * The four routes driven end to end: the real `withAccount` wrapper, the real
 * handlers, the real repositories, a real Postgres. Only the session reader is
 * substituted — whose account this is comes from the session and never from the
 * request, and that seam has its own test.
 *
 * The responses are parsed with the frozen schemas rather than poked at by
 * hand, so a shape the front end's mocks do not expect fails here.
 */

const available = await databaseAvailable()

describe.skipIf(!available)('the bell and the attention list', () => {
  let harness: TestDb
  let mine: string
  let theirs: string

  beforeAll(async () => {
    harness = await setupTestDb('web_notifications')
  })

  afterAll(async () => {
    await harness.close()
  })

  beforeEach(async () => {
    await truncateAll(harness.pool)
    const { rows } = await harness.pool.query<{ id: string; email: string }>(
      "INSERT INTO accounts (email) VALUES ('mine@example.com'), ('theirs@example.com') RETURNING id, email",
    )
    mine = rows.find((r) => r.email === 'mine@example.com')!.id
    theirs = rows.find((r) => r.email === 'theirs@example.com')!.id
  })

  const store = () => makeNotificationStore({ database: harness.db })
  const emitter = () => new DbNotificationEmitter(harness.db)

  const bell = (accountId: string | null) =>
    withAccount(makeNotificationsHandler(store()), async () => accountId)
  const seen = (accountId: string | null) =>
    withAccount(makeSeenHandler(store()), async () => accountId)
  const read = (accountId: string | null) =>
    withAccount(makeReadHandler(store()), async () => accountId)
  const attention = (accountId: string | null) =>
    withAccount(makeAttentionHandler(store()), async () => accountId)

  const get = (url = 'http://localhost/api/notifications') => new Request(url)
  const post = (url: string) => new Request(url, { method: 'POST' })

  it('refuses a request with no session', async () => {
    expect((await bell(null)(get(), undefined)).status).toBe(401)
  })

  it("returns this account's notifications and nobody else's", async () => {
    await emitter().emit('article_published', { article_id: 'a-1' }, 'a-1', accountAttribution(mine))
    await emitter().emit(
      'article_published',
      { article_id: 'b-1' },
      'b-1',
      accountAttribution(theirs),
    )

    const response = await bell(mine)(get(), undefined)
    expect(response.status).toBe(200)

    const body = notificationsResponseSchema.parse(await response.json())
    expect(body.unseenCount).toBe(1)
    expect(body.notifications.map((n) => n.refs)).toEqual([{ article_id: 'a-1' }])
  })

  it('carries references and no display text, whatever the copy says', async () => {
    await emitter().emit(
      'topic_held_by_gate',
      { topic_id: 't-1' },
      't-1',
      accountAttribution(mine),
    )

    const body = notificationsResponseSchema.parse(await (await bell(mine)(get(), undefined)).json())
    // The sentence is produced when the bell renders. Nothing here is a word a
    // merchant reads, so rewording it never touches a stored row.
    expect(Object.values(body.notifications[0]!.refs)).toEqual(['t-1'])
  })

  it('rejects a `since` that is not a date rather than ignoring it', async () => {
    const response = await bell(mine)(get('http://localhost/api/notifications?since=yesterday'), undefined)
    expect(response.status).toBe(400)
  })

  it('clears the badge when the bell is opened, and marks one item read', async () => {
    await emitter().emit('article_published', { article_id: 'a-1' }, 'a-1', accountAttribution(mine))

    expect((await seen(mine)(post('http://localhost/api/notifications/seen'), undefined)).status).toBe(200)

    let body = notificationsResponseSchema.parse(await (await bell(mine)(get(), undefined)).json())
    expect(body.unseenCount).toBe(0)
    expect(body.notifications[0]!.readAt).toBeNull()

    const id = body.notifications[0]!.id
    const marked = await read(mine)(post(`http://localhost/api/notifications/${id}/read`), {
      params: Promise.resolve({ notificationId: id }),
    })
    expect(marked.status).toBe(200)

    body = notificationsResponseSchema.parse(await (await bell(mine)(get(), undefined)).json())
    expect(body.notifications[0]!.readAt).not.toBeNull()
  })

  it("answers another account's notification the way it answers a missing one", async () => {
    await emitter().emit(
      'article_published',
      { article_id: 'b-1' },
      'b-1',
      accountAttribution(theirs),
    )
    const body = notificationsResponseSchema.parse(
      await (await bell(theirs)(get(), undefined)).json(),
    )
    const id = body.notifications[0]!.id

    const response = await read(mine)(post(`http://localhost/api/notifications/${id}/read`), {
      params: Promise.resolve({ notificationId: id }),
    })
    expect(response.status).toBe(404)
  })

  it('lists an attention item while the condition holds, and stops the moment it does not', async () => {
    const { rows } = await harness.pool.query<{ id: string }>(
      `INSERT INTO opportunities
         (account_id, signal_type, entity_type, entity_ref, evidence_json, impact,
          impact_score, confidence, reason_template_key, recommended_action, status, rules_version)
       VALUES ($1,'catalog_richness_gap','product','product:1','[]'::jsonb,'high',
          80, 70, 'catalog_richness_gap.default', 'hold', 'new', 'abc123')
       RETURNING id`,
      [mine],
    )
    await harness.pool.query(
      `INSERT INTO opportunity_tasks (opportunity_id, kind, description, state)
       VALUES ($1,'product_data','Add fabric and care details','open')`,
      [rows[0]!.id],
    )

    const list = async () =>
      attentionResponseSchema.parse(
        await (await attention(mine)(get('http://localhost/api/attention'), undefined)).json(),
      ).items

    expect((await list()).map((item) => item.kind)).toEqual(['merchant_task'])

    await harness.pool.query(`UPDATE opportunity_tasks SET state = 'applied', applied_at = now()`)

    expect(await list()).toEqual([])
  })
})
