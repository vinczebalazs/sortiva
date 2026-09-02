import {
  closeAccount,
  type AccessRevoker,
  type AccountLifecycleStore,
  type Logger,
  type SubscriptionCanceller,
} from '@sortiva/core'
import { runtimeLogger } from '../runtime/logging'
import { withAccountLock } from '../runtime/lock'
import { registerTask } from '../runtime/tasks'
import { ACCOUNT_CLOSE_TASK, type AccountClosePayload } from './queue'
import type pg from 'pg'

/**
 * Telling three vendors that a merchant has gone.
 *
 * Runs as a job rather than inside the request that deleted the account, for
 * two reasons. A Stripe call may never sit in a request path — that rule exists
 * so a Stripe outage can never become a product outage. And a queued step is
 * retried and, when it runs out of attempts, dead-letters where somebody is
 * alerted; a call inside the request gets one attempt and leaves the merchant
 * guessing whether their subscription was really cancelled.
 *
 * The payload is an account id and nothing else. The credentials this job hands
 * back are read out of the database when it runs — a queue payload is a row in
 * a table, and a token does not belong in one.
 */

export interface AccountCloseDeps {
  readonly getPool: () => pg.Pool
  readonly store: () => AccountLifecycleStore
  readonly billing: () => SubscriptionCanceller
  readonly revoker: () => AccessRevoker
  readonly log?: Logger
}

export async function runAccountClose(
  deps: AccountCloseDeps,
  payload: AccountClosePayload,
): Promise<void> {
  const log = deps.log ?? runtimeLogger()
  // Blocking rather than try-and-skip: this is the last thing that will ever
  // happen for this account, and skipping it would leave a subscription
  // running with nothing scheduled to try again.
  await withAccountLock(deps.getPool(), payload.accountId, async () => {
    const result = await closeAccount(
      { store: deps.store(), billing: deps.billing(), revoker: deps.revoker(), log },
      { accountId: payload.accountId },
    )
    if (result.kind === 'skipped') {
      log.info('account_close_skipped', { account_id: payload.accountId, why: result.why })
      return
    }
    log.info('account_closed', {
      account_id: payload.accountId,
      subscription_cancelled: result.subscriptionCancelled,
      shopify_revoked: result.revoked.shopify ?? 'none',
      google_revoked: result.revoked.google ?? 'none',
    })
  })
}

let registered = false

export function registerAccountCloseTask(deps: AccountCloseDeps): void {
  if (registered) return
  registered = true
  registerTask(ACCOUNT_CLOSE_TASK, async (rawPayload) => {
    const payload = rawPayload as AccountClosePayload
    if (!payload?.accountId) throw new Error('account_close needs an accountId')
    await runAccountClose(deps, payload)
  })
}

/** Test-only: the task registry is a module singleton, and so is this latch. */
export function resetAccountCloseRegistration(): void {
  registered = false
}
