/**
 * Every recurring job the product runs. The registry lives here so the full set
 * of scheduled work is visible in one file; the tasks themselves are
 * owned by the lanes that build them, and a name here without a task registered
 * is caught at worker start (see `assertCrontabTasksExist`).
 *
 * Times are UTC — Graphile's crontab is server-time. Per-account clock work
 * (the publish hour in the persona country's timezone; the Monday signal scan
 * on the persona clock) is resolved *inside* the task
 * against `account_settings.timezone`, not by the schedule. A crontab cannot
 * express "09:00 in each account's own zone", and pretending otherwise is how
 * a German store gets published to at 09:00 UTC.
 */

export interface CronEntry {
  /** Graphile task name. */
  task: string
  /** Standard 5-field crontab expression, UTC. */
  schedule: string
  /** Why this job exists and what it is expected to do. */
  why: string
}

export const CRON_ENTRIES: readonly CronEntry[] = [
  {
    task: 'generation_cycle_daily',
    schedule: '0 3 * * *',
    why: 'The daily generation cycle. Runs early enough that grading and the one repair loop finish before any account\'s publish hour.',
  },
  {
    task: 'reconciliation_sweep_daily',
    schedule: '30 4 * * *',
    why: 'Catches catalog changes the webhooks missed, and syncs the store\'s content inventory.',
  },
  {
    task: 'gsc_sync_daily',
    schedule: '0 5 * * *',
    why: 'Pulls the day\'s Search Console page-by-query data.',
  },
  {
    task: 'landing_revenue_aggregate_daily',
    schedule: '30 5 * * *',
    why: 'Aggregates revenue by landing page. V1 only captures it; nothing reads it yet.',
  },
  {
    task: 'signal_scan_weekly',
    schedule: '0 6 * * 1',
    why: 'The weekly signal scan. The task filters to accounts for whom it is locally Monday, because the schedule cannot express per-account time zones.',
  },
  {
    task: 'ctr_curve_refit_weekly',
    schedule: '0 7 * * 1',
    why: 'Refits each store\'s own click-through curve, which is what the low-CTR signal compares against instead of an absolute rate.',
  },
  {
    task: 'replenishment_monthly',
    schedule: '0 8 1 * *',
    why: 'Tops the calendar back up when its planned horizon drops below the configured number of days.',
  },
  {
    task: 'monthly_summary',
    schedule: '0 * * * *',
    why:
      'The monthly summary email, which has to land at 08:00 in the store\'s own morning — a crontab ' +
      'cannot say that, so the sweep runs hourly and each run asks per account whether it is locally ' +
      'the first at eight. Running it 24 times a day costs nothing: the bell entry and the email both ' +
      'key on the month covered, so every run after the one that matched inserts nothing.',
  },
  {
    task: 'email_send_drain',
    schedule: '* * * * *',
    why:
      'Turns each queued email into its own job. Per-row rather than one batch so that one address ' +
      'the vendor keeps rejecting cannot hold up everybody else\'s mail behind it. Every minute, ' +
      'because a payment-failed or connection-lost email an hour late has already cost the merchant ' +
      'an hour of stopped pipeline.',
  },
  {
    task: 'publish_intent_recovery_sweep',
    schedule: '*/5 * * * *',
    why: 'Finds publish attempts that never confirmed, checks the remote for our marker, and adopts or retries them — so a crash mid-publish cannot leave a post half-made or make two.',
  },
  {
    task: 'spend_cap_sweep',
    schedule: '*/5 * * * *',
    why:
      'Sums the day\'s vendor spending out of our own ledger and pauses whatever crossed a ceiling — ' +
      'one account, enrichment everywhere, or the logged-out preview. ' +
      'The interval is what bounds the overspend: nothing else looks at the meter, so between two ' +
      'runs a runaway is unbounded. Cheap to run — three sums over an indexed window.',
  },
  {
    task: 'oauth_reminder_sweep',
    schedule: '0 * * * *',
    why: 'Sends the 24-hour reminder to finish connecting Shopify. Safe to run repeatedly: the notification dedupe key stops a second send.',
  },
  {
    task: 'export_url_reminder_sweep',
    schedule: '15 * * * *',
    why: 'Sends the 7-day reminder that an exported article has not been published yet.',
  },
  {
    task: 'subscription_reconciliation_nightly',
    schedule: '0 2 * * *',
    why: 'Re-fetches any subscription we have not heard about in over a day, so a missed webhook cannot leave someone wrongly entitled or wrongly cut off. This is the only place we call Stripe on a schedule; no request path ever does.',
  },
  {
    task: 'retention_sweep_daily',
    schedule: '0 1 * * *',
    why:
      'Three obligations about time, in this order. It honours a store redaction request — a merchant ' +
      'who uninstalled us and asked Shopify to have their store data erased — which runs first ' +
      'because the only durable record of such a request is a stored delivery, and this same job ' +
      'deletes stored deliveries at thirty days. It erases accounts whose merchant asked to be ' +
      'deleted a week ago, which is the same act that releases their domain. Then it ' +
      'deletes what we no longer need: notifications at 90d, email_sends at 12mo, webhook_events at 30d, ' +
      'request_cache and unused sign-in links on their own expiry, gsc rows at 16mo. ' +
      // `idempotency_ledger` is the record of which paid work has already been
      // done. Delete a row inside the
      // window in which the queue could still redeliver that work and the replay
      // runs it for real: a re-billed Shopify crawl for `catalog_sync`, a
      // re-billed set of LLM calls for `distill`. So it is prunable only by age,
      // and only well past redelivery — never by job, never by account, and
      // never as part of deleting a store's data. `ledger.test.ts` fails if any
      // production code path deletes from it at all, so a future age-based sweep
      // has to change that test deliberately rather than by accident.
      'idempotency_ledger: PRUNE BY AGE ONLY, never by job or account — it is the record of completed paid work, not history.',
  },
]

/** The crontab text Graphile Worker parses. */
export function crontab(entries: readonly CronEntry[] = CRON_ENTRIES): string {
  return entries.map((e) => `${e.schedule} ${e.task}`).join('\n')
}

/**
 * A crontab entry naming a task nobody registered is a job that silently never
 * runs. Checked at worker start rather than discovered a month later.
 */
export function assertCrontabTasksExist(
  registeredTasks: readonly string[],
  entries: readonly CronEntry[] = CRON_ENTRIES,
): void {
  const registered = new Set(registeredTasks)
  const missing = entries.map((e) => e.task).filter((task) => !registered.has(task))
  if (missing.length > 0) {
    throw new Error(
      `crontab references tasks with no registered handler: ${missing.join(', ')}. ` +
        `Register them in the task list, or remove the crontab entry.`,
    )
  }
}
