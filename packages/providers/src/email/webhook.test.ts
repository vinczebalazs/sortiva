import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  parseResendEvent,
  suppressionReasonFor,
  verifyResendWebhook,
  webhookHeadersFrom,
  WebhookVerificationError,
} from './webhook'

/**
 * The receiver is public, so the signature is the whole authentication. These
 * cases are the ways someone would try to get past it.
 */

const SECRET = `whsec_${Buffer.from('a-signing-secret').toString('base64')}`
const NOW = new Date('2026-09-01T12:00:00Z')

function sign(body: string, id: string, timestamp: string, secret = SECRET) {
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64')
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`
}

const BODY = JSON.stringify({
  type: 'email.bounced',
  data: { email_id: 'msg-1', to: ['Merchant@Example.com'] },
})
const TS = String(Math.floor(NOW.getTime() / 1000))

describe('verifying a Resend webhook', () => {
  it('accepts a delivery signed with our secret', () => {
    expect(() =>
      verifyResendWebhook(
        BODY,
        { id: 'evt-1', timestamp: TS, signature: sign(BODY, 'evt-1', TS) },
        SECRET,
        NOW,
      ),
    ).not.toThrow()
  })

  it('rejects a body that changed after it was signed', () => {
    const tampered = BODY.replace('email.bounced', 'email.delivered')
    expect(() =>
      verifyResendWebhook(
        tampered,
        { id: 'evt-1', timestamp: TS, signature: sign(BODY, 'evt-1', TS) },
        SECRET,
        NOW,
      ),
    ).toThrow(WebhookVerificationError)
  })

  it('rejects a signature made with somebody else’s secret', () => {
    const other = `whsec_${Buffer.from('not-ours').toString('base64')}`
    expect(() =>
      verifyResendWebhook(
        BODY,
        { id: 'evt-1', timestamp: TS, signature: sign(BODY, 'evt-1', TS, other) },
        SECRET,
        NOW,
      ),
    ).toThrow(/does not match/)
  })

  it('rejects a genuine signature replayed hours later', () => {
    // Without the timestamp check a captured delivery stays valid forever.
    const later = new Date(NOW.getTime() + 6 * 60 * 60 * 1000)
    expect(() =>
      verifyResendWebhook(
        BODY,
        { id: 'evt-1', timestamp: TS, signature: sign(BODY, 'evt-1', TS) },
        SECRET,
        later,
      ),
    ).toThrow(/too far from now/)
  })

  it('rejects a delivery with no signature at all', () => {
    expect(() =>
      verifyResendWebhook(BODY, { id: null, timestamp: null, signature: null }, SECRET, NOW),
    ).toThrow(/headers are missing/)
  })

  it('refuses to verify when no secret is configured, rather than passing everything', () => {
    expect(() =>
      verifyResendWebhook(BODY, { id: 'e', timestamp: TS, signature: 'v1,x' }, '', NOW),
    ).toThrow(/no signing secret/)
  })

  it('accepts either header spelling', () => {
    const headers = new Headers({ 'webhook-id': 'evt-1', 'webhook-timestamp': TS })
    expect(webhookHeadersFrom(headers).id).toBe('evt-1')
  })

  it('takes any one signature in the list, so a secret can be rotated', () => {
    const good = sign(BODY, 'evt-1', TS)
    expect(() =>
      verifyResendWebhook(
        BODY,
        { id: 'evt-1', timestamp: TS, signature: `v1,stale ${good}` },
        SECRET,
        NOW,
      ),
    ).not.toThrow()
  })
})

describe('reading a Resend event', () => {
  it('lower-cases every recipient, because a suppression is about the address', () => {
    expect(parseResendEvent(JSON.parse(BODY))).toEqual({
      type: 'email.bounced',
      recipients: ['merchant@example.com'],
      providerMessageId: 'msg-1',
    })
  })

  it('suppresses on a bounce and on a complaint, and on nothing else', () => {
    expect(suppressionReasonFor('email.bounced')).toBe('bounced')
    expect(suppressionReasonFor('email.complained')).toBe('complained')
    expect(suppressionReasonFor('email.delivered')).toBeUndefined()
    expect(suppressionReasonFor('email.opened')).toBeUndefined()
  })

  it('returns nothing for a body that is not an event', () => {
    expect(parseResendEvent('nope')).toBeUndefined()
    expect(parseResendEvent({ data: {} })).toBeUndefined()
  })
})
