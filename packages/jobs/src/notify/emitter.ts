import {
  TEMPLATE_VERSIONS,
  assertReferenceOnly,
  emailFanOut,
  notificationChannels,
  type NotificationEmitter,
  type NotificationType,
} from '@sortiva/core'
import type { EventAttribution } from '@sortiva/core'
import {
  accountEmailAddress,
  accountScope,
  emitNotification,
  isEmailSuppressed,
  queueEmail,
  readNotificationPrefs,
  systemScope,
  type Db,
} from '@sortiva/db'
import { runtimeLogger } from '../runtime/logging'

/**
 * The real bell. Every lane calls `emit` at its own points; this is the one
 * place that turns those calls into rows.
 *
 * Two guarantees, and they are the reason this is not just an insert:
 *
 *  - **It rings once.** The unique `(account_id, type, dedupe_key)` triple makes
 *    the second insert a no-op, so a publish job that the queue delivers twice
 *    still produces one notification. `created` tells the caller which of the
 *    two happened, without a second read.
 *  - **It stores no words.** The payload is checked before the insert: ids and
 *    short tokens only. A caller that passes an article's headline gets an error
 *    rather than a row that outlives the article.
 *
 * `inTransaction` is how a notification commits with the thing it reports. A
 * "held by the quality bar" notification written outside the transaction that
 * records the decision could survive a rollback and tell the merchant about
 * something that never happened.
 *
 * **It also decides the inbox.** One event, up to two places: the row above,
 * and — for the kinds that are emailed, to a merchant who has not switched them
 * off, at an address that has not bounced — a queued `email_sends` row. Doing
 * that here rather than at each emission point is what stops a lane having to
 * know whether its event is emailed, and it is why a sweep that runs every hour
 * mails once: both rows key on the same derived triple, so every run after the
 * first inserts nothing.
 */
export class DbNotificationEmitter implements NotificationEmitter {
  constructor(private readonly handle: Db | (() => Db)) {}

  /** The same emitter, writing through an open transaction. */
  inTransaction(tx: Db): DbNotificationEmitter {
    return new DbNotificationEmitter(tx)
  }

  async emit(
    type: NotificationType,
    refs: Readonly<Record<string, string>>,
    dedupeKey: string,
    attribution: EventAttribution,
  ): Promise<{ created: boolean }> {
    if (attribution.kind !== 'account') {
      // Every notification belongs to somebody. A preview happens before an
      // account exists and has nobody to tell.
      throw new Error(`Cannot emit "${type}": notifications need an account, not a preview visitor.`)
    }
    if (!dedupeKey) {
      throw new Error(
        `Cannot emit "${type}" without a dedupe key. It is derived from the event — ` +
          `${describeDedupeKey(type)} — never generated, or a retry would ring twice.`,
      )
    }
    assertReferenceOnly(refs)

    const db = typeof this.handle === 'function' ? this.handle() : this.handle
    const scope = accountScope(attribution.accountId)
    const row = await emitNotification(db, scope, { type, dedupeKey, payload: refs })

    await this.fanOutToEmail(db, attribution.accountId, type, dedupeKey)

    return { created: row !== undefined }
  }

  /**
   * The second channel. Three separate things can stop it and each is asked
   * separately, because they mean different things: the kind is never emailed,
   * the merchant switched it off, or the address bounced. The last still writes
   * a row — marked as stopped — so "why did I never get that" has an answer.
   *
   * A failure here is logged and swallowed. The notification is already written
   * and the state change it reports is committing with it; losing the mail is
   * bad, losing the decision because the mail could not be queued is worse.
   *
   * Swallowing it is only *possible* because the whole fan-out runs inside a
   * savepoint. Postgres aborts an entire transaction on any failed statement, so
   * catching the error here without one would leave the caller's transaction
   * poisoned: every statement after it fails, and the state change this
   * notification reports rolls back — the exact outcome the catch exists to
   * prevent. The savepoint is what confines the damage to the email.
   */
  private async fanOutToEmail(
    db: Db,
    accountId: string,
    type: NotificationType,
    dedupeKey: string,
  ): Promise<void> {
    const row = notificationChannels(type)
    if (row.email === 'none' || row.email === 'monthly_summary_only') return

    try {
      await db.transaction(async (tx) => {
        const scope = accountScope(accountId)
        const [address, prefs] = await Promise.all([
          accountEmailAddress(tx, scope),
          readNotificationPrefs(tx, scope),
        ])
        if (!address) return

        const suppressed = await isEmailSuppressed(
          tx,
          systemScope('a suppressed address stays suppressed whichever account is mailing it'),
          address,
        )
        const decision = emailFanOut(type, {
          suppressed,
          ...(prefs
            ? {
                preferences: {
                  emailArticlePublished: prefs.emailArticlePublished,
                  emailDigestFrequency: prefs.emailDigestFrequency,
                },
              }
            : {}),
        })
        if (!decision.send) return

        await queueEmail(tx, scope, {
          type,
          // The same key as the notification, so the two channels deduplicate
          // together and a retried job produces neither a second bell nor a
          // second email.
          dedupeKey,
          templateVersion:
            type === 'monthly_summary_ready'
              ? TEMPLATE_VERSIONS['monthly-summary']
              : TEMPLATE_VERSIONS.notice,
          state: decision.state,
        })
      })
    } catch (error) {
      runtimeLogger().error('notification.email_fanout_failed', {
        account_id: accountId,
        type,
        error_class: error instanceof Error ? error.name : 'unknown',
      })
    }
  }
}

/** What this type's key is supposed to be made of, for the error above. */
function describeDedupeKey(type: NotificationType): string {
  const source = notificationChannels(type).dedupeKey
  switch (source.kind) {
    case 'ref':
      return `the \`${source.ref}\` it refers to`
    case 'iso_week':
      return 'the ISO week the scan ran in'
    case 'year_month':
      return 'the month it covers'
    case 'sweep_threshold':
      return 'the account and the threshold that fired'
  }
}
