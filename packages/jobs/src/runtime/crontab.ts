/**
 * tech §2 — "Scheduled jobs (Graphile crontab)". The registry lives here so the
 * full set of recurring work is visible in one file; the tasks themselves are
 * owned by the lanes that build them, and a name here without a task registered
 * is caught at worker start (see `assertCrontabTasksExist`).
 *
 * Times are UTC — Graphile's crontab is server-time. Per-account clock work
 * (the publish hour in the persona country's timezone, main §9.4; the Monday
 * signal scan on the persona clock, main §9.6.1) is resolved *inside* the task
 * against `account_settings.timezone`, not by the schedule. A crontab cannot
 * express "09:00 in each account's own zone", and pretending otherwise is how
 * a German store gets published to at 09:00 UTC.
 */

export interface CronEntry {
  /** Graphile task name. */
  task: string
  /** Standard 5-field crontab expression, UTC. */
  schedule: string
  /** Why this exists, and which section requires it. */
  spec: string
}

export const CRON_ENTRIES: readonly CronEntry[] = [
  {
    task: 'generation_cycle_daily',
    schedule: '0 3 * * *',
    spec: 'main §9.1 — the daily generation cycle, run early enough that Gate 3 and the repair loop finish before any account\'s publish hour (§9.4).',
  },
  {
    task: 'reconciliation_sweep_daily',
    schedule: '30 4 * * *',
    spec: 'main §14.1, §14.3.8 — catalog drift sweep; also syncs the content inventory (main §12.3).',
  },
  {
    task: 'gsc_sync_daily',
    schedule: '0 5 * * *',
    spec: 'main §12.2 — daily GSC page × query sync.',
  },
  {
    task: 'landing_revenue_aggregate_daily',
    schedule: '30 5 * * *',
    spec: 'main §17.3 — daily landing-revenue aggregation, capture only in V1.',
  },
  {
    task: 'signal_scan_weekly',
    schedule: '0 6 * * 1',
    spec: 'main §7.5, §9.6.1 — the Monday signal scan. The task filters to accounts whose local Monday it is.',
  },
  {
    task: 'ctr_curve_refit_weekly',
    schedule: '0 7 * * 1',
    spec: 'tech §2 — weekly CTR-curve refit; the input to the Low-CTR signal (main §7.3).',
  },
  {
    task: 'replenishment_monthly',
    schedule: '0 8 1 * *',
    spec: 'main §9.6.1 — monthly replenishment when the planned horizon drops below the configured days.',
  },
  {
    task: 'monthly_summary',
    schedule: '0 8 1 * *',
    spec: 'tech §1.4 — the monthly summary email, assembled per account at 08:00 persona-country time.',
  },
  {
    task: 'publish_intent_recovery_sweep',
    schedule: '*/5 * * * *',
    spec: 'main §14.3.7 — every 5 min, adopt or re-execute pending publish intents older than 10 min.',
  },
  {
    task: 'oauth_reminder_sweep',
    schedule: '0 * * * *',
    spec: 'tech §1.4 — hourly sweep for the 24h OAuth reminder; idempotent via the notification dedupe key.',
  },
  {
    task: 'export_url_reminder_sweep',
    schedule: '15 * * * *',
    spec: 'tech §1.4 — hourly sweep for the 7d export-URL reminder.',
  },
  {
    task: 'subscription_reconciliation_nightly',
    schedule: '0 2 * * *',
    spec: 'main §4.2, tech §3 — re-fetch any subscription whose synced_at is >24h stale. No Stripe call ever sits in a request path.',
  },
  {
    task: 'retention_sweep_daily',
    schedule: '0 1 * * *',
    spec:
      'tech §1.7, §2.1 — notifications at 90d, email_sends at 12mo, webhook_events at 30d, ' +
      'request_cache on TTL, gsc rollups at 16mo. ' +
      // NEVER PRUNABLE: `job_steps` and `ingestion_jobs`. Those rows are not a
      // log of past runs — they *are* the record of which paid work has already
      // been done (main §14.3.2, "the cache is the ledger"). Deleting one lets a
      // replay re-run its work for real: a re-billed Shopify crawl for
      // `catalog_sync`, a re-billed set of LLM calls for `distill`. Whoever
      // implements this sweep must leave both tables alone; the test in
      // `ledger.test.ts` fails if any code path starts deleting them.
      'NEVER PRUNABLE: job_steps and ingestion_jobs — they are the idempotency ledger (§14.3.2), not history.',
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
