import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { accountAttribution, mintUnsubscribeToken } from '@sortiva/core'
import { makeEmailStore } from '@sortiva/db'
import {
  databaseAvailable,
  insertAccount,
  setupTestDb,
  truncateAll,
  type TestDb,
} from '@sortiva/db/testing'
import { DbNotificationEmitter } from '@sortiva/jobs/notify/emitter'
import { handleUnsubscribe } from './handler'

/**
 * One-click unsubscribe, end to end. It runs with no session, so the two things
 * that matter are that a link we signed changes exactly one setting and that a
 * link we did not sign changes nothing — while looking identical from outside,
 * so the endpoint cannot be used to find out whether an account id is real.
 */

const available = await databaseAvailable()
const SECRET = 'unsubscribe-signing-secret'

describe.skipIf(!available)('one-click unsubscribe', () => {
  let harness: TestDb
  let accountId: string

  beforeAll(async () => {
    harness = await setupTestDb('web_unsubscribe')
  })

  afterAll(async () => {
    await harness.close()
  })

  beforeEach(async () => {
    await truncateAll(harness.pool)
    accountId = await insertAccount(harness.pool, 'merchant@example.com')
  })

  const options = () => ({ database: harness.db, secret: SECRET })
  const prefs = () => makeEmailStore({ database: harness.db }).preferences(accountId)

  const link = (target: 'email_article_published' | 'email_digest_frequency') =>
    `https://sortiva.app/api/notifications/unsubscribe?token=${mintUnsubscribeToken({ accountId, target }, SECRET)}`

  it('stops the monthly summary, and says so on a page', async () => {
    const response = await handleUnsubscribe(new Request(link('email_digest_frequency')), options())

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(await response.text()).toContain('You are unsubscribed')
    expect(await prefs()).toEqual({ emailArticlePublished: false, emailDigestFrequency: 'off' })
  })

  it('answers a mail client’s one-click POST with no page at all', async () => {
    const response = await handleUnsubscribe(
      new Request(link('email_digest_frequency'), { method: 'POST' }),
      options(),
    )
    expect(response.status).toBe(204)
    expect((await prefs())?.emailDigestFrequency).toBe('off')
  })

  it('changes only the setting the link was signed for', async () => {
    await makeEmailStore({ database: harness.db }).savePreferences(accountId, {
      emailArticlePublished: true,
      emailDigestFrequency: 'weekly',
    })

    await handleUnsubscribe(new Request(link('email_article_published')), options())

    expect(await prefs()).toEqual({ emailArticlePublished: false, emailDigestFrequency: 'weekly' })
  })

  it('leaves the summary on when the merchant has never opened settings', async () => {
    // No preference row exists, so unsubscribing from per-article mail must not
    // let the other column take its database default and quietly stop the
    // monthly summary too.
    await handleUnsubscribe(new Request(link('email_article_published')), options())
    expect((await prefs())?.emailDigestFrequency).toBe('weekly')
  })

  it('and the summary keeps arriving after that', async () => {
    await handleUnsubscribe(new Request(link('email_article_published')), options())

    const emitter = new DbNotificationEmitter(harness.db)
    await emitter.emit('monthly_summary_ready', {}, '2026-08', accountAttribution(accountId))

    const { rows } = await harness.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM email_sends WHERE type = 'monthly_summary_ready'",
    )
    expect(rows[0]!.n).toBe(1)
  })

  it('changes nothing for a link we did not sign, and looks the same doing it', async () => {
    const forged = `https://sortiva.app/api/notifications/unsubscribe?token=${accountId}.email_digest_frequency.forged`
    const response = await handleUnsubscribe(new Request(forged), options())

    expect(response.status).toBe(200)
    expect(await prefs()).toBeUndefined()
  })

  it('changes nothing when there is no token at all', async () => {
    const response = await handleUnsubscribe(
      new Request('https://sortiva.app/api/notifications/unsubscribe'),
      options(),
    )
    expect(response.status).toBe(200)
    expect(await prefs()).toBeUndefined()
  })
})
