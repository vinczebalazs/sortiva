import type { EmailStore } from '@sortiva/core'
import { db, type Db } from '../client'
import {
  accountEmailAddress,
  findEmailSend,
  isEmailSuppressed,
  listQueuedEmailSends,
  markEmailFailed,
  markEmailSent,
  markEmailSuppressed,
  readNotificationPrefs,
  saveNotificationPrefs,
  suppressEmailAddress,
} from '../repositories/email'
import { queueEmail, type EmailSendRow } from '../repositories/notifications'
import { accountScope, systemScope } from '../scope'

/**
 * Binds the email pipeline to this deployment's database. The send worker and
 * the webhook receiver are handed this port and hold no database handle, which
 * is what keeps every read named with the account it is for.
 */
export interface EmailStoreOptions {
  /** An integration test hands in its own isolated database; production uses the pool. */
  database?: Db
}

function view(row: EmailSendRow) {
  return {
    id: row.id,
    accountId: row.accountId,
    type: row.type,
    dedupeKey: row.dedupeKey,
    templateVersion: row.templateVersion,
    state: row.state,
  }
}

export function makeEmailStore(options: EmailStoreOptions = {}): EmailStore {
  const database = (): Db => options.database ?? db()

  return {
    async queue(input) {
      const row = await queueEmail(database(), accountScope(input.accountId), {
        type: input.type,
        dedupeKey: input.dedupeKey,
        templateVersion: input.templateVersion,
        state: input.state,
      })
      return row ? view(row) : undefined
    },

    async get(id) {
      // The account comes off the row: the worker is handed an id by a queue
      // message, and every write below is scoped by what this read returns.
      const row = await readRow(database(), id)
      return row ? view(row) : undefined
    },

    async listQueued(limit) {
      const rows = await listQueuedEmailSends(
        database(),
        systemScope('the send worker drains queued mail for every account'),
        limit,
      )
      return rows.map(view)
    },

    markSent(id, providerMessageId) {
      return withAccount(database(), id, (scope) =>
        markEmailSent(database(), scope, id, providerMessageId),
      )
    },

    markFailed(id, lastError) {
      return withAccount(database(), id, (scope) => markEmailFailed(database(), scope, id, lastError))
    },

    markSuppressed(id) {
      return withAccount(database(), id, (scope) => markEmailSuppressed(database(), scope, id))
    },

    accountEmail(accountId) {
      return accountEmailAddress(database(), accountScope(accountId))
    },

    isSuppressed(address) {
      return isEmailSuppressed(
        database(),
        systemScope('a suppressed address stays suppressed across every account'),
        address,
      )
    },

    async suppress(address, reason) {
      await suppressEmailAddress(
        database(),
        systemScope('bounce and complaint webhooks arrive before we know whose address it is'),
        address,
        reason,
      )
    },

    async preferences(accountId) {
      const row = await readNotificationPrefs(database(), accountScope(accountId))
      if (!row) return undefined
      return {
        emailArticlePublished: row.emailArticlePublished,
        emailDigestFrequency: row.emailDigestFrequency,
      }
    },

    async savePreferences(accountId, preferences) {
      await saveNotificationPrefs(database(), accountScope(accountId), preferences)
    },
  }
}

/** The row's own account, so a settle is still scoped without the caller carrying one. */
async function withAccount(
  database: Db,
  id: string,
  run: (scope: ReturnType<typeof accountScope>) => Promise<boolean>,
): Promise<boolean> {
  const row = await readRow(database, id)
  if (!row) return false
  return run(accountScope(row.accountId))
}

function readRow(database: Db, id: string): Promise<EmailSendRow | undefined> {
  return findEmailSend(
    database,
    systemScope('the send worker is handed a row id and reads the account off the row'),
    id,
  )
}
