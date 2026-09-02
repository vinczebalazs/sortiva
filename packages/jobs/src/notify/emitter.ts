import {
  assertReferenceOnly,
  notificationChannels,
  type NotificationEmitter,
  type NotificationType,
} from '@sortiva/core'
import type { EventAttribution } from '@sortiva/core'
import { accountScope, emitNotification, type Db } from '@sortiva/db'

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
    const row = await emitNotification(db, accountScope(attribution.accountId), {
      type,
      dedupeKey,
      payload: refs,
    })
    return { created: row !== undefined }
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
