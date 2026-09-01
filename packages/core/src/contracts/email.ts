/**
 * All email goes through one provider, wrapped in this interface, so the send
 * worker and the tests never touch a vendor SDK directly.
 *
 * The database's unique constraint on `(account_id, type, dedupe_key)` is the
 * exactly-once guarantee; `idempotencyKey` carries the same triple to the vendor
 * so provider-side dedupe backs it up.
 */

export interface EmailMessage {
  readonly to: string
  readonly subject: string
  readonly html: string
  readonly text?: string
  /** `${accountId}:${type}:${dedupeKey}` — the same triple as the database constraint. */
  readonly idempotencyKey: string
  /** Stamped on every `email_sends` row, so a complaint traces back to the exact template. */
  readonly templateVersion: string
  /** `List-Unsubscribe` and `List-Unsubscribe-Post`, on non-transactional mail. */
  readonly headers?: Record<string, string>
  readonly replyTo?: string
}

export interface EmailSendResult {
  readonly providerMessageId: string
}

/** The send worker treats 429s and 5xx as retryable; everything else is terminal. */
export class EmailSendFailure extends Error {
  constructor(
    readonly retryable: boolean,
    readonly errorClass: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options as ErrorOptions)
    this.name = 'EmailSendFailure'
  }
}

export interface EmailProvider {
  send(message: EmailMessage): Promise<EmailSendResult>
}
