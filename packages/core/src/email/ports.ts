import type { EmailMessage, EmailProvider } from '../contracts/email'
import type { NotificationType } from '../contracts/opportunities'
import type { NotificationPreferences } from './policy'
import type { EmailContent } from './content'

/**
 * What the email pipeline needs from storage and from the outside world, as
 * ports. Nothing in this package opens a database or a socket, so the send
 * worker's decisions can be exercised against fakes and the same code runs in
 * production against Postgres and Resend.
 */

export type EmailSendState = 'queued' | 'sent' | 'failed' | 'suppressed'

export interface EmailSendRecord {
  readonly id: string
  readonly accountId: string
  readonly type: NotificationType
  readonly dedupeKey: string
  readonly templateVersion: string
  readonly state: EmailSendState
}

export interface EmailStore {
  /**
   * Insert-or-ignore on `(account_id, type, dedupe_key)`. Returns undefined when
   * the row already existed, which is how a sweep that runs every hour sends
   * once.
   */
  queue(input: {
    accountId: string
    type: NotificationType
    dedupeKey: string
    templateVersion: string
    state: EmailSendState
  }): Promise<EmailSendRecord | undefined>
  get(id: string): Promise<EmailSendRecord | undefined>
  listQueued(limit: number): Promise<EmailSendRecord[]>
  /** Guarded on the row still being `queued`; false means somebody else settled it. */
  markSent(id: string, providerMessageId: string): Promise<boolean>
  markFailed(id: string, lastError: string): Promise<boolean>
  markSuppressed(id: string): Promise<boolean>
  accountEmail(accountId: string): Promise<string | undefined>
  isSuppressed(address: string): Promise<boolean>
  suppress(address: string, reason: 'bounced' | 'complained' | 'unsubscribed'): Promise<void>
  preferences(accountId: string): Promise<NotificationPreferences | undefined>
  savePreferences(accountId: string, preferences: NotificationPreferences): Promise<void>
}

/**
 * Turns a queued row into the words to send. Everything it needs that is not in
 * the row — an article's title, how many opportunities were found — it looks up
 * now, because the stored row holds identifiers only.
 *
 * Undefined means the email should not go: the thing it was about is gone.
 */
export interface EmailAssembler {
  assemble(record: EmailSendRecord): Promise<EmailContent | undefined>
}

/**
 * Copy keys to HTML and to the plain-text alternative. Implemented over React
 * Email in `packages/providers`; declared here so this package never imports
 * React.
 */
export interface EmailRenderer {
  render(content: EmailContent): Pick<EmailMessage, 'subject' | 'html' | 'text'>
}

export interface EmailSendDeps {
  readonly store: EmailStore
  readonly assembler: EmailAssembler
  readonly renderer: EmailRenderer
  readonly provider: EmailProvider
}
