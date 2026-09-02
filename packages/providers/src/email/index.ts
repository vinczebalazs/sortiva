export * from './webhook'

import { Resend } from 'resend'
import {
  EmailSendFailure,
  type EmailMessage,
  type EmailProvider,
  type EmailSendResult,
} from '@sortiva/core'

/**
 * All email goes through Resend, wrapped in a thin `EmailProvider` interface so
 * the send worker and the tests never touch the SDK directly. Resend is the
 * committed vendor, not a placeholder — the interface is for testability, not
 * for keeping options open.
 *
 * The message's `idempotencyKey` is our `(account_id, type, dedupe_key)` triple,
 * the same one the `email_sends` unique index enforces. Sending it as Resend's
 * idempotency key puts provider-side dedupe on top of our DB constraint, so a
 * send that succeeds remotely and fails to record locally still cannot go twice.
 */

export interface ResendEmailProviderOptions {
  apiKey?: string
  /** A dedicated sending subdomain, with SPF, DKIM and DMARC verified, so our transactional mail does not ride on the main domain's reputation. */
  from?: string
  client?: Resend
}

export class ResendEmailProvider implements EmailProvider {
  private readonly client: Resend
  private readonly from: string

  constructor(options: ResendEmailProviderOptions = {}) {
    const apiKey = options.apiKey ?? process.env.RESEND_API_KEY
    if (!options.client && !apiKey) {
      throw new Error('RESEND_API_KEY is not set. Use MockEmailProvider outside production.')
    }
    this.client = options.client ?? new Resend(apiKey)
    this.from = options.from ?? process.env.EMAIL_FROM ?? ''
    if (!this.from) {
      throw new Error('EMAIL_FROM is not set; Resend requires a verified sender address.')
    }
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    let response: Awaited<ReturnType<Resend['emails']['send']>>
    try {
      response = await this.client.emails.send(
        {
          from: this.from,
          to: message.to,
          subject: message.subject,
          html: message.html,
          ...(message.text ? { text: message.text } : {}),
          ...(message.headers ? { headers: message.headers } : {}),
          ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        },
        { idempotencyKey: message.idempotencyKey },
      )
    } catch (error) {
      throw new EmailSendFailure(true, 'email_connection', `Resend send failed: ${String(error)}`, {
        cause: error,
      })
    }

    if (response.error) {
      // Rate limits and vendor-side faults are worth retrying; a rejected
      // address or a malformed payload would fail identically forever.
      const name = response.error.name ?? 'unknown'
      const retryable = name === 'rate_limit_exceeded' || name === 'internal_server_error'
      throw new EmailSendFailure(
        retryable,
        `email_${name}`,
        `Resend rejected the send: ${response.error.message}`,
      )
    }

    if (!response.data?.id) {
      throw new EmailSendFailure(true, 'email_no_id', 'Resend returned no message id')
    }

    return { providerMessageId: response.data.id }
  }
}

export interface SentEmail extends EmailMessage {
  readonly providerMessageId: string
}

/**
 * Test double. It enforces the idempotency contract rather than merely recording
 * calls: a second send with the same key returns the first result, exactly as
 * Resend's idempotency key does — so a test of the send worker's retry path
 * exercises the behaviour production will show.
 */
export class MockEmailProvider implements EmailProvider {
  readonly sent: SentEmail[] = []
  private readonly byKey = new Map<string, SentEmail>()
  private nextFailure: EmailSendFailure | undefined

  /** The next `send()` throws this. Drives the retry and DLQ paths in tests. */
  failNext(failure: EmailSendFailure): void {
    this.nextFailure = failure
  }

  reset(): void {
    this.sent.length = 0
    this.byKey.clear()
    this.nextFailure = undefined
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    if (this.nextFailure) {
      const failure = this.nextFailure
      this.nextFailure = undefined
      throw failure
    }

    const existing = this.byKey.get(message.idempotencyKey)
    if (existing) return { providerMessageId: existing.providerMessageId }

    const record: SentEmail = { ...message, providerMessageId: `mock-${this.byKey.size + 1}` }
    this.byKey.set(message.idempotencyKey, record)
    this.sent.push(record)
    return { providerMessageId: record.providerMessageId }
  }

  to(address: string): SentEmail[] {
    return this.sent.filter((m) => m.to === address)
  }
}
