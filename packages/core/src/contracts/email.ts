/**
 * tech §1.4 — "All email goes through Resend, still wrapped in a thin
 * `EmailProvider` interface … so the send worker and tests never touch the SDK
 * directly." The DB unique constraint on `(account_id, type, dedupe_key)` is the
 * exactly-once guarantee; `idempotencyKey` carries the same triple to the vendor
 * so provider-side dedupe backs it up.
 */

export interface EmailMessage {
  readonly to: string
  readonly subject: string
  readonly html: string
  readonly text?: string
  /** `${accountId}:${type}:${dedupeKey}` — the same triple as the DB constraint (tech §1.4). */
  readonly idempotencyKey: string
  /** Stamped on every `email_sends` row, same reproducibility posture as prompts (tech §1.4). */
  readonly templateVersion: string
  /** tech §1.5 — `List-Unsubscribe` and `List-Unsubscribe-Post` on non-transactional mail. */
  readonly headers?: Record<string, string>
  readonly replyTo?: string
}

export interface EmailSendResult {
  readonly providerMessageId: string
}

/** Retryable per main §14.3.5 — the send worker treats 429s and 5xx as retryable. */
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
