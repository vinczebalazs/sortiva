import { accountScope, resumeStepsAfterReauth, findDomainForAccount, transitionDomainState, type Db } from '@sortiva/db'
import { runtimeLogger } from '../runtime/logging'
import { findRunForAccount, remainingSteps } from '../runtime/steps'

/**
 * Putting a store back to work after the merchant reconnects it.
 *
 * Losing a connection is a pause, and this is the other half of it. Without
 * this the pause was permanent in the quietest possible way: the store moved to
 * "waiting for Shopify", the merchant reconnected, the new token was stored —
 * and nothing moved it back. Every scheduled thing that works on a store looks
 * for stores that are ready, so that account's calendar, its opportunity scans
 * and its learning simply stopped, with a working connection and no error
 * anywhere.
 *
 * Two things are undone, in this order. The steps that stopped because Shopify
 * refused the old token are made due again — and only those, so a step that
 * failed for its own reasons is not quietly restarted by an unrelated act of
 * the merchant's. Then the store leaves the reconnect screen: back into
 * onboarding if it never finished, or back to ready if it had.
 */
export async function resumeAfterReconnect(
  db: Db,
  accountId: string,
): Promise<'resumed_onboarding' | 'restored_ready' | 'nothing_to_resume'> {
  const log = runtimeLogger().child({ account_id: accountId })
  const scope = accountScope(accountId)

  const domain = await findDomainForAccount(db, scope)
  if (domain?.state !== 'awaiting_shopify_auth') return 'nothing_to_resume'

  const run = await findRunForAccount(db, accountId)
  if (!run) {
    // No onboarding run at all. Nothing here can say where this store should
    // go, and inventing a state would be worse than leaving it where the
    // merchant can see it.
    return 'nothing_to_resume'
  }

  const revived = await resumeStepsAfterReauth(db, run.jobId)
  const remaining = await remainingSteps(db, run.jobId)

  if (remaining.length === 0) {
    // Onboarding had finished before the connection broke. The store goes back
    // to where it was rather than through an onboarding it has already done.
    const moved = await transitionDomainState(db, scope, ['awaiting_shopify_auth'], 'ready_for_planning')
    log.info('shopify_reconnect_restored', { revived_steps: revived, moved: moved !== undefined })
    return 'restored_ready'
  }

  // Still mid-onboarding. The `oauth_wait` step moves the store itself once it
  // runs, so nothing here touches the domain state: doing both would be two
  // writers for one transition.
  log.info('shopify_reconnect_resumed', { revived_steps: revived, remaining: remaining.length })
  return 'resumed_onboarding'
}
