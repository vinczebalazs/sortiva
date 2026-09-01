import { reconcileSubscriptions } from '@sortiva/core'
import { registerTask } from '@sortiva/jobs'
import { billingWorkerDeps, drainNow } from './receiver'

/**
 * Stripe is the source of truth and our row is a cache of it, re-derived
 * nightly because webhooks drop here as everywhere else. Anything we have not
 * heard about for a day is re-fetched.
 *
 * `subscription_reconciliation_nightly` is already in the worker's crontab
 * (`packages/jobs` CRON_ENTRIES); this is the handler it names. Registering it
 * does not by itself switch the schedule on: the worker enables cron only once
 * every scheduled task has a handler, and the other lanes' tasks land later.
 */
export const RECONCILIATION_TASK = 'subscription_reconciliation_nightly'

/** Not in the crontab: the receiver starts it, and the nightly job backstops it. */
export const STRIPE_DRAIN_TASK = 'stripe_event_drain'

let registered = false

export function registerBillingTasks(): void {
  if (registered) return
  registered = true

  registerTask(RECONCILIATION_TASK, async () => {
    const report = await reconcileSubscriptions(billingWorkerDeps())
    if (report.missing.length > 0) {
      console.error(
        `[billing] reconciliation could not read ${report.missing.length} subscription(s) from Stripe`,
      )
    }
  })

  registerTask(STRIPE_DRAIN_TASK, async () => {
    await drainNow()
  })
}
