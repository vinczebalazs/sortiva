import { EmailSendFailure } from '../contracts/email'
import { unsubscribeHeaders } from './unsubscribe'
import type { EmailSendDeps, EmailSendRecord } from './ports'

/**
 * Sending one queued email.
 *
 * The queue is at-least-once, so this can be handed the same row twice. Three
 * separate things stop that becoming two emails, and they are layered on
 * purpose because each covers a different failure:
 *
 *  - the row is re-read and only sent while it still says `queued`, so a second
 *    delivery of the same job finds it settled and stops;
 *  - the mark-as-sent is a guarded update, so two workers racing produce one
 *    winner and the loser learns it lost *after* the provider deduplicated;
 *  - the provider is given `account:type:dedupe_key` as its own idempotency key,
 *    so even a send that succeeded remotely and then failed to record locally
 *    cannot go out again.
 *
 * The caller is expected to hold the account's advisory lock, which is what
 * makes the middle layer rare rather than routine.
 */

export type SendOutcome =
  /** Sent, and the row now says so. */
  | { readonly status: 'sent'; readonly providerMessageId: string }
  /** Somebody else already settled it, or it was never queued. */
  | { readonly status: 'already_settled' }
  /** The address is on the suppression list; recorded, not sent. */
  | { readonly status: 'suppressed' }
  /** The thing it was about no longer exists, so there is nothing to say. */
  | { readonly status: 'abandoned'; readonly reason: string }
  /** A vendor fault worth another attempt. The caller schedules it. */
  | { readonly status: 'retry'; readonly attempt: number; readonly errorClass: string; readonly lastError: string }
  /** Give up: the row is marked failed and the caller writes the dead-letter entry. */
  | { readonly status: 'dead_letter'; readonly errorClass: string; readonly lastError: string; readonly attempts: number }

export interface SendOptions {
  /** 1 on the first attempt. */
  readonly attempt: number
  /** How many attempts are allowed in total, from the runtime's retry policy. */
  readonly maxAttempts: number
  /** Where the one-click unsubscribe link points, when this kind carries one. */
  readonly unsubscribeUrl?: string
}

function describe(error: unknown): { errorClass: string; message: string; retryable: boolean } {
  if (error instanceof EmailSendFailure) {
    return { errorClass: error.errorClass, message: error.message, retryable: error.retryable }
  }
  // Under an at-least-once queue an unrecognised failure is treated as
  // retryable: sending twice is deduplicated, never sending is not.
  return {
    errorClass: 'email_unknown',
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
  }
}

export async function sendQueuedEmail(
  deps: EmailSendDeps,
  emailSendId: string,
  options: SendOptions,
): Promise<SendOutcome> {
  const record = await deps.store.get(emailSendId)
  if (!record || record.state !== 'queued') return { status: 'already_settled' }

  const address = await deps.store.accountEmail(record.accountId)
  if (!address) {
    await deps.store.markFailed(emailSendId, 'the account has no address, or is gone')
    return { status: 'abandoned', reason: 'no_address' }
  }

  if (await deps.store.isSuppressed(address)) {
    // Checked again here and not only when the row was queued: an address can
    // bounce in the minutes between the two, and the whole point of a
    // suppression list is that we stop immediately.
    await deps.store.markSuppressed(emailSendId)
    return { status: 'suppressed' }
  }

  const content = await deps.assembler.assemble(record)
  if (!content) {
    await deps.store.markFailed(emailSendId, 'nothing left to say about it')
    return { status: 'abandoned', reason: 'subject_gone' }
  }

  const rendered = deps.renderer.render(content)
  const headers = content.unsubscribeUrl ? unsubscribeHeaders(content.unsubscribeUrl) : undefined

  try {
    const result = await deps.provider.send({
      to: address,
      subject: rendered.subject,
      html: rendered.html,
      ...(rendered.text ? { text: rendered.text } : {}),
      // The database's unique triple, handed to the vendor as theirs.
      idempotencyKey: idempotencyKeyFor(record),
      templateVersion: record.templateVersion,
      ...(headers ? { headers } : {}),
    })
    const marked = await deps.store.markSent(emailSendId, result.providerMessageId)
    if (!marked) return { status: 'already_settled' }
    return { status: 'sent', providerMessageId: result.providerMessageId }
  } catch (error) {
    const failure = describe(error)
    const exhausted = options.attempt >= options.maxAttempts
    if (failure.retryable && !exhausted) {
      return {
        status: 'retry',
        attempt: options.attempt + 1,
        errorClass: failure.errorClass,
        lastError: failure.message,
      }
    }
    await deps.store.markFailed(emailSendId, `${failure.errorClass}: ${failure.message}`)
    return {
      status: 'dead_letter',
      errorClass: failure.errorClass,
      lastError: failure.message,
      attempts: options.attempt,
    }
  }
}

/** The database's unique triple, in the shape the vendor's idempotency header takes. */
export function idempotencyKeyFor(record: Pick<EmailSendRecord, 'accountId' | 'type' | 'dedupeKey'>): string {
  return `${record.accountId}:${record.type}:${record.dedupeKey}`
}
