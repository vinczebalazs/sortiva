import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Verifying that a webhook really came from Resend.
 *
 * The endpoint is public — it has to be — so the signature is the whole
 * authentication. Resend signs with the Standard Webhooks scheme: an HMAC over
 * `id.timestamp.body`, keyed by a secret we hold, with the body being the exact
 * bytes sent. Re-serialising the parsed JSON changes those bytes, which is why
 * this takes the raw text and the receiver reads the body once.
 *
 * The timestamp is checked as well as the signature. Without that, a signature
 * captured from a real delivery stays valid forever and can be replayed at any
 * time; with it, a captured request is useless within minutes.
 */

export class WebhookVerificationError extends Error {
  constructor(readonly reason: string) {
    super(`Resend webhook rejected: ${reason}`)
    this.name = 'WebhookVerificationError'
  }
}

/** Five minutes either way, the scheme's own tolerance — enough for clock drift, not for a replay. */
export const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60

export interface WebhookHeaders {
  readonly id: string | null
  readonly timestamp: string | null
  readonly signature: string | null
}

export function webhookHeadersFrom(headers: Headers): WebhookHeaders {
  return {
    id: headers.get('svix-id') ?? headers.get('webhook-id'),
    timestamp: headers.get('svix-timestamp') ?? headers.get('webhook-timestamp'),
    signature: headers.get('svix-signature') ?? headers.get('webhook-signature'),
  }
}

/** `whsec_<base64>` is the portal's display form; the key is the decoded part. */
function secretKey(secret: string): Buffer {
  const raw = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret
  return Buffer.from(raw, 'base64')
}

export function verifyResendWebhook(
  rawBody: string,
  headers: WebhookHeaders,
  secret: string,
  now: Date = new Date(),
): void {
  if (!secret) throw new WebhookVerificationError('no signing secret is configured')
  if (!headers.id || !headers.timestamp || !headers.signature) {
    throw new WebhookVerificationError('the signature headers are missing')
  }

  const sentAt = Number(headers.timestamp)
  if (!Number.isFinite(sentAt)) throw new WebhookVerificationError('the timestamp is not a number')
  const driftSeconds = Math.abs(Math.floor(now.getTime() / 1000) - sentAt)
  if (driftSeconds > TIMESTAMP_TOLERANCE_SECONDS) {
    throw new WebhookVerificationError('the timestamp is too far from now to be a live delivery')
  }

  const expected = createHmac('sha256', secretKey(secret))
    .update(`${headers.id}.${headers.timestamp}.${rawBody}`)
    .digest('base64')

  // The header carries a space-separated list so a secret can be rotated with
  // both keys live; any one matching is a pass.
  const offered = headers.signature.split(' ').map((part) => part.split(',').pop() ?? '')
  const expectedBuffer = Buffer.from(expected)
  const matched = offered.some((candidate) => {
    const given = Buffer.from(candidate)
    return given.length === expectedBuffer.length && timingSafeEqual(given, expectedBuffer)
  })
  if (!matched) throw new WebhookVerificationError('the signature does not match')
}

/** Only what we act on. Anything else is stored and ignored. */
export type ResendEventType = 'email.bounced' | 'email.complained' | 'email.delivered'

export interface ResendEvent {
  readonly type: string
  readonly recipients: readonly string[]
  readonly providerMessageId?: string
}

/**
 * Resend sends `to` as an array — one delivery, possibly several addresses.
 * Every one of them is suppressed on a bounce, because the bounce is about the
 * address, not about the message.
 */
export function parseResendEvent(payload: unknown): ResendEvent | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const body = payload as { type?: unknown; data?: unknown }
  if (typeof body.type !== 'string') return undefined
  const data = (typeof body.data === 'object' && body.data !== null ? body.data : {}) as {
    to?: unknown
    email_id?: unknown
  }
  const to = Array.isArray(data.to)
    ? data.to.filter((value): value is string => typeof value === 'string')
    : typeof data.to === 'string'
      ? [data.to]
      : []
  return {
    type: body.type,
    recipients: to.map((address) => address.trim().toLowerCase()).filter(Boolean),
    ...(typeof data.email_id === 'string' ? { providerMessageId: data.email_id } : {}),
  }
}

/** Which of our suppression reasons an event means, or none. */
export function suppressionReasonFor(
  type: string,
): 'bounced' | 'complained' | undefined {
  if (type === 'email.bounced') return 'bounced'
  if (type === 'email.complained') return 'complained'
  return undefined
}
