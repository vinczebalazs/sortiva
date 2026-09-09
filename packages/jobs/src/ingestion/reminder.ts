import { accountAttribution, type NotificationEmitter } from '@sortiva/core'
import { type Db, storesAwaitingShopifyAuth, systemScope } from '@sortiva/db'
import { runtimeLogger } from '../runtime/logging'
import { registerTask } from '../runtime/tasks'

/**
 * A merchant who started connecting their store and walked away hears from us
 * once, a day later.
 *
 * The connect screen persists on every dashboard visit, so this is the nudge for
 * someone who has not come back at all. It is a sweep rather than a scheduled
 * message per merchant because there is nothing to cancel: a merchant who
 * connects in the meantime simply stops matching.
 */

export const OAUTH_REMINDER_SWEEP_TASK = 'oauth_reminder_sweep'

/**
 * How long a store may sit unconnected before we say something. Long enough that
 * someone who stepped away mid-install is not chased, short enough that the
 * thing they were doing is still in their head.
 */
const REMINDER_AFTER_HOURS = 24

export interface ReminderSweepResult {
  readonly considered: number
  readonly notified: number
}

export async function sweepOauthReminders(
  db: Db,
  notifications: NotificationEmitter,
  now: Date = new Date(),
): Promise<ReminderSweepResult> {
  const log = runtimeLogger()
  const cutoff = new Date(now.getTime() - REMINDER_AFTER_HOURS * 60 * 60 * 1000)

  const waiting = await storesAwaitingShopifyAuth(
    db,
    systemScope('the reminder sweep looks across every store waiting to be connected'),
    cutoff,
  )

  let notified = 0
  for (const store of waiting) {
    // One reminder per account. The append-only unique key on
    // (account, type, dedupe key) is what makes running this sweep every hour
    // free: every run after the first inserts nothing.
    const emitted = await notifications.emit(
      'oauth_reminder',
      { domain: store.domainNormalized },
      `shopify_connect:${store.accountId}`,
      accountAttribution(store.accountId, store.domainNormalized),
    )
    if (emitted.created) notified += 1
  }

  log.info('oauth_reminder_sweep.completed', { considered: waiting.length, notified })
  return { considered: waiting.length, notified }
}

let registered = false

export function registerReminderTasks(
  getDb: () => Db,
  getNotifications: () => NotificationEmitter,
): void {
  if (registered) return
  registered = true
  registerTask(OAUTH_REMINDER_SWEEP_TASK, async () => {
    await sweepOauthReminders(getDb(), getNotifications())
  }, 'fans_out')
}

/** Test-only: the registry is a module singleton and so is this latch. */
export function resetReminderTaskRegistration(): void {
  registered = false
}
