import {
  DOMAIN_RELEASE_GRACE_DAYS,
  PURGE_DEADLINE_DAYS,
  retentionCutoff,
  type Logger,
} from '@sortiva/core'
import {
  accountScope,
  accountsDueForPurge,
  findAccountByShopHandleIncludingLost,
  hardDeleteAccount,
  pruneEmailSends,
  pruneExpiredRequestCache,
  pruneExpiredSessions,
  pruneExpiredVerificationTokens,
  pruneGscDaily,
  pruneGscQueryDaily,
  pruneNotifications,
  pruneWebhookEvents,
  purgeStoreDerived,
  storedRedactionRequests,
  systemScope,
  type Db,
} from '@sortiva/db'
import type pg from 'pg'
import { runtimeLogger } from '../runtime/logging'
import { tryWithAccountLock } from '../runtime/lock'
import { registerTask } from '../runtime/tasks'

/**
 * The nightly pass that keeps promises about time.
 *
 * Three obligations, deliberately in this order:
 *
 * 1. **Honour store redaction requests.** A merchant who uninstalls us and asks
 *    Shopify to have their store's data erased. Runs first because the only
 *    durable record of such a request is a stored delivery — and step 3 deletes
 *    stored deliveries at thirty days, which is the same day the obligation
 *    matures. Honouring first means a request is acted on the night it arrives
 *    and the prune never races it.
 * 2. **Erase deleted accounts** whose seven-day hold has passed. The same act
 *    releases their domain, because the domain row is a child of the account
 *    row.
 * 3. **Prune what we no longer need**, table by table, each by age.
 *
 * Every step is "do what is not yet done": a second run the same night finds
 * nothing left to do rather than doing it twice. There is no cursor and no
 * bookmark to get wrong.
 */

export const RETENTION_SWEEP_TASK = 'retention_sweep_daily'

export interface RetentionSweepDeps {
  readonly getDb: () => Db
  readonly getPool: () => pg.Pool
  readonly log?: Logger
  readonly now?: () => Date
}

export interface RetentionSweepReport {
  /** Store redaction requests acted on this pass. */
  storesRedacted: number
  /** Deleted accounts whose rows and domain claim went this pass. */
  accountsErased: number
  /** Accounts whose erase was deferred because the store was busy. */
  accountsBusy: number
  pruned: Record<string, number>
}

const DAY = 24 * 60 * 60 * 1000

export async function runRetentionSweep(
  deps: RetentionSweepDeps,
  options: { limit?: number } = {},
): Promise<RetentionSweepReport> {
  const db = deps.getDb()
  const log = deps.log ?? runtimeLogger()
  const now = deps.now?.() ?? new Date()
  const limit = options.limit ?? 100

  const report: RetentionSweepReport = {
    storesRedacted: 0,
    accountsErased: 0,
    accountsBusy: 0,
    pruned: {},
  }

  report.storesRedacted = await honourRedactions(deps, db, now, log, limit)

  const erase = await erasePurgedAccounts(deps, db, now, log, limit)
  report.accountsErased = erase.erased
  report.accountsBusy = erase.busy

  report.pruned = await prune(db, now)

  log.info('retention_swept', {
    stores_redacted: report.storesRedacted,
    accounts_erased: report.accountsErased,
    accounts_busy: report.accountsBusy,
    ...Object.fromEntries(Object.entries(report.pruned).map(([k, v]) => [`pruned_${k}`, v])),
  })
  return report
}

/**
 * Erasing a store's data because its merchant asked Shopify to have it erased.
 *
 * Idempotent without a marker, and the shape of that matters: erasing the data
 * also deletes the store's connection row, so the next pass finds no account
 * behind that handle and does nothing. A merchant who reinstalls gets a new
 * connection row with a later timestamp, and a request that predates it is left
 * alone — otherwise the following night would erase the store they just
 * reconnected.
 */
async function honourRedactions(
  deps: RetentionSweepDeps,
  db: Db,
  now: Date,
  log: Logger,
  limit: number,
): Promise<number> {
  const system = systemScope('a redaction request names a store, not an account')
  const requests = await storedRedactionRequests(db, system, {
    since: new Date(now.getTime() - PURGE_DEADLINE_DAYS * DAY),
    limit,
  })

  let honoured = 0
  for (const request of requests) {
    const connection = await findAccountByShopHandleIncludingLost(db, system, request.shopHandle)
    if (!connection) continue
    if (connection.connectedAt > request.receivedAt) {
      // The store was connected again after this request was made, so the
      // request is about a relationship that has since restarted.
      continue
    }

    const done = await tryWithAccountLock(deps.getPool(), connection.accountId, async () => {
      await purgeStoreDerived(db, accountScope(connection.accountId))
      return true
    })
    if (!done) continue

    honoured += 1
    log.info('store_redaction_honoured', {
      webhook_id: request.webhookId,
      account_id: connection.accountId,
    })
  }
  return honoured
}

/**
 * Erasing accounts whose merchant asked to be deleted a week ago.
 *
 * One delete each; the cascade takes the domain claim, the settings, the
 * catalogue, the bell and the mail records with it. Releasing the domain is
 * that same delete — which is why the erase waits for the hold rather than
 * running the moment deletion is requested.
 */
async function erasePurgedAccounts(
  deps: RetentionSweepDeps,
  db: Db,
  now: Date,
  log: Logger,
  limit: number,
): Promise<{ erased: number; busy: number }> {
  const system = systemScope('the sweep erases every account whose hold has passed')
  // The same hold, read backwards: which deletion stamps are now old enough.
  const deletedBefore = new Date(now.getTime() - DOMAIN_RELEASE_GRACE_DAYS * DAY)
  const due = await accountsDueForPurge(db, system, { before: deletedBefore, limit })

  let erased = 0
  let busy = 0
  for (const accountId of due) {
    const outcome = await tryWithAccountLock(deps.getPool(), accountId, () =>
      hardDeleteAccount(db, accountScope(accountId)),
    )
    if (outcome === undefined) {
      // Something is still working on this account. Next pass; nothing is lost
      // and no worker parks on a lock.
      busy += 1
      continue
    }
    if (outcome) {
      erased += 1
      log.info('account_erased', { account_id: accountId })
    }
  }
  return { erased, busy }
}

async function prune(db: Db, now: Date): Promise<Record<string, number>> {
  const system = systemScope('retention is measured in days, not in accounts')
  const at = (target: Parameters<typeof retentionCutoff>[0]): Date => {
    const cutoff = retentionCutoff(target, now)
    if (!cutoff) throw new Error(`${target} has no age-based cutoff`)
    return cutoff
  }

  return {
    webhook_events: await pruneWebhookEvents(db, system, at('webhook_events')),
    notifications: await pruneNotifications(db, system, at('notifications')),
    email_sends: await pruneEmailSends(db, system, at('email_sends')),
    request_cache: await pruneExpiredRequestCache(db, system, now),
    verification_tokens: await pruneExpiredVerificationTokens(db, system, now),
    gsc_daily: await pruneGscDaily(db, system, isoDate(at('gsc_daily'))),
    gsc_query_daily: await pruneGscQueryDaily(db, system, isoDate(at('gsc_query_daily'))),
    // Last on purpose, and it should stay last. These properties are evaluated
    // in the order they are written, and this is the only tidying step here
    // with no obligation behind it — nothing is promised to anybody about when
    // a lapsed session's row goes, only that a lapsed session cannot sign in,
    // which the lookup already refuses. Moved earlier, a failure on this delete
    // would cost the night whatever came after it.
    sessions: await pruneExpiredSessions(db, system, now),
  }
}

/** The Search Console tables key on a calendar date, not an instant. */
function isoDate(at: Date): string {
  return at.toISOString().slice(0, 10)
}

let registered = false

export function registerRetentionTask(deps: RetentionSweepDeps): void {
  if (registered) return
  registered = true
  registerTask(RETENTION_SWEEP_TASK, async () => {
    await runRetentionSweep(deps)
  })
}

/** Test-only: the task registry is a module singleton, and so is this latch. */
export function resetRetentionTaskRegistration(): void {
  registered = false
}
