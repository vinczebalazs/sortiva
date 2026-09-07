import { db, type Db } from '../client'
import { readNotificationPrefs, saveNotificationPrefs } from '../repositories/email'
import type { NotificationPrefsRow } from '../repositories/email'
import { readPublishTarget, setDeliveryMode } from '../repositories/publishing'
import type { PublishTargetRow } from '../repositories/publishing'
import { readSettingsScreen, saveSettingsScreen } from '../repositories/settings'
import type { SettingsScreenRow } from '../repositories/settings'
import type { AccountScope } from '../scope'

/**
 * Everything the two Settings screens read and change.
 *
 * The settings a merchant sees on one screen live in three tables — the account
 * settings themselves, the email preferences, and the Shopify connection that
 * decides whether auto-publish may be switched on at all. A store rather than
 * loose functions for the reason the products store gives: the route must not
 * hold a raw database handle, and the handle here is resolved on the call
 * rather than at construction, so a build that evaluates the module without a
 * database configured does not fail.
 */

export interface SettingsStoreOptions {
  /** An integration test hands in its own isolated database; production uses the pool. */
  database?: Db
}

export interface SettingsStore {
  read(scope: AccountScope): Promise<SettingsScreenRow>
  save(
    scope: AccountScope,
    patch: Partial<Omit<SettingsScreenRow, 'delivery'>>,
    now?: Date,
  ): Promise<void>
  emailPrefs(scope: AccountScope): Promise<NotificationPrefsRow | undefined>
  saveEmailPrefs(
    scope: AccountScope,
    prefs: {
      emailArticlePublished: boolean
      emailDigestFrequency: NotificationPrefsRow['emailDigestFrequency']
    },
  ): Promise<void>
  /** The write grant and the target blog, which together decide whether auto-publish may go on. */
  publishTarget(scope: AccountScope): Promise<PublishTargetRow | undefined>
  /**
   * Switches delivery, carrying the auto-publish conditions in its own `WHERE`
   * clause. Answers false when it refused, which is the second of the two
   * checks that stand between a stale read and posting without permission.
   */
  setDelivery(scope: AccountScope, delivery: 'export' | 'auto'): Promise<boolean>
}

export function makeSettingsStore(options: SettingsStoreOptions = {}): SettingsStore {
  const database = (): Db => options.database ?? db()
  return {
    read: (scope) => readSettingsScreen(database(), scope),
    save: (scope, patch, now) => saveSettingsScreen(database(), scope, patch, now),
    emailPrefs: (scope) => readNotificationPrefs(database(), scope),
    saveEmailPrefs: (scope, prefs) => saveNotificationPrefs(database(), scope, prefs),
    publishTarget: (scope) => readPublishTarget(database(), scope),
    setDelivery: (scope, delivery) => setDeliveryMode(database(), scope, delivery),
  }
}
