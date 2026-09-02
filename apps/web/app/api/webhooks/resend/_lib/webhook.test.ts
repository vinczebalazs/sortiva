import { createHmac } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { databaseAvailable, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { handleResendWebhook } from './receiver'

/**
 * The bounce receiver, end to end against a real Postgres.
 *
 * What it has to get right is small and consequential: an unsigned request is
 * refused, a signed one is stored once however many times it arrives, and an
 * address that bounced stops receiving mail from that moment. Continuing to
 * mail an address that bounces is how a sending domain's reputation dies, and
 * it takes every other merchant's mail with it.
 */

const available = await databaseAvailable()
const SECRET = `whsec_${Buffer.from('a-signing-secret').toString('base64')}`

function delivery(body: string, id: string, now: Date) {
  const timestamp = String(Math.floor(now.getTime() / 1000))
  const key = Buffer.from(SECRET.slice('whsec_'.length), 'base64')
  const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')
  return new Request('https://sortiva.app/api/webhooks/resend', {
    method: 'POST',
    body,
    headers: {
      'svix-id': id,
      'svix-timestamp': timestamp,
      'svix-signature': `v1,${signature}`,
      'content-type': 'application/json',
    },
  })
}

describe.skipIf(!available)('the Resend receiver', () => {
  let harness: TestDb
  const now = new Date('2026-09-01T12:00:00Z')

  beforeAll(async () => {
    harness = await setupTestDb('web_resend')
  })

  afterAll(async () => {
    await harness.close()
  })

  beforeEach(async () => {
    await truncateAll(harness.pool)
  })

  const options = () => ({ database: harness.db, secret: SECRET, now: () => now })

  const suppressed = async () => {
    const { rows } = await harness.pool.query<{ email: string; reason: string }>(
      'SELECT email, reason FROM email_suppressions ORDER BY email',
    )
    return rows
  }

  it('stops mailing an address that bounced', async () => {
    const body = JSON.stringify({
      type: 'email.bounced',
      data: { email_id: 'msg-1', to: ['Merchant@Example.com'] },
    })
    const response = await handleResendWebhook(delivery(body, 'evt-1', now), options())

    expect(response.status).toBe(200)
    // Lower-cased on the way in, because the suppression is about the address
    // and mail servers do not care about its case.
    expect(await suppressed()).toEqual([{ email: 'merchant@example.com', reason: 'bounced' }])
  })

  it('stops mailing an address that reported us as spam', async () => {
    const body = JSON.stringify({ type: 'email.complained', data: { to: ['angry@example.com'] } })
    await handleResendWebhook(delivery(body, 'evt-2', now), options())
    expect(await suppressed()).toEqual([{ email: 'angry@example.com', reason: 'complained' }])
  })

  it('suppresses nobody on a delivery report', async () => {
    const body = JSON.stringify({ type: 'email.delivered', data: { to: ['fine@example.com'] } })
    await handleResendWebhook(delivery(body, 'evt-3', now), options())
    expect(await suppressed()).toEqual([])
  })

  it('answers a redelivery without acting on it twice', async () => {
    const body = JSON.stringify({ type: 'email.bounced', data: { to: ['dup@example.com'] } })
    const first = await handleResendWebhook(delivery(body, 'evt-4', now), options())
    const again = await handleResendWebhook(delivery(body, 'evt-4', now), options())

    expect(first.status).toBe(200)
    expect(await again.json()).toEqual({ received: true, duplicate: true })

    const { rows } = await harness.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM webhook_events',
    )
    expect(rows[0]!.n).toBe(1)
  })

  it('refuses a request that is not signed, and stores nothing', async () => {
    const response = await handleResendWebhook(
      new Request('https://sortiva.app/api/webhooks/resend', {
        method: 'POST',
        body: JSON.stringify({ type: 'email.bounced', data: { to: ['x@example.com'] } }),
      }),
      options(),
    )
    expect(response.status).toBe(400)
    expect(await suppressed()).toEqual([])

    const { rows } = await harness.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM webhook_events',
    )
    expect(rows[0]!.n).toBe(0)
  })

  it('refuses a body edited after it was signed', async () => {
    const signed = JSON.stringify({ type: 'email.delivered', data: { to: ['x@example.com'] } })
    const request = delivery(signed, 'evt-5', now)
    const tampered = new Request(request, {
      body: JSON.stringify({ type: 'email.bounced', data: { to: ['x@example.com'] } }),
    })

    const response = await handleResendWebhook(tampered, options())
    expect(response.status).toBe(400)
    expect(await suppressed()).toEqual([])
  })
})
