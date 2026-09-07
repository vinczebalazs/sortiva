import { accountAttribution, type PosthogCapture } from '../contracts/analytics'
import type { Logger } from '../observability/logger'
import type { AccessRevoker, AccountLifecycleStore, SubscriptionCanceller } from './ports'
import { domainReleaseAt } from './retention'

/**
 * A merchant asking to be deleted, in two halves.
 *
 * **The half that runs while they are waiting** touches nothing outside our own
 * database: the deletion stamp, the domain's release deadline, both connections
 * marked dead, every signed-in browser signed out, and the preview row dropped.
 * It is one guarded transaction, so a second click changes nothing and a crash
 * half way leaves the account exactly as it was.
 *
 * **The half that talks to vendors runs as a job**: cancel the subscription,
 * hand back the Shopify grant, hand back the Google grant, then delete the
 * stored tokens. It is out of the request for two reasons. The rule is that no
 * Stripe call ever sits in a request path — a rule written so that a Stripe
 * outage can never become a product outage. And it is genuinely better here: a
 * queued step is retried and, if it runs out of retries, dead-letters where
 * somebody is alerted, whereas a call inside the request gets one attempt and a
 * merchant who has to guess whether their subscription was cancelled.
 *
 * **What deliberately happens in neither half is erasing the rows.** The domain
 * row is a child of the account row, so erasing the account now would free the
 * domain the same hour — the exact thing the seven-day hold exists to prevent.
 * The sweep does it on the day the hold ends.
 */

export const ACCOUNT_DELETED_EVENT = 'account_deleted'

export interface RequestDeletionDeps {
  readonly store: AccountLifecycleStore
  readonly capture?: Pick<PosthogCapture, 'capture'>
  readonly now?: () => Date
}

export type RequestDeletionResult =
  | {
      readonly kind: 'deleted'
      readonly deletedAt: Date
      /** When the domain becomes claimable again. Null when none was claimed. */
      readonly domainFreeAt: Date | null
    }
  | { readonly kind: 'not_found' }
  /** Already deleted, or another request won the guarded update. Answered as success. */
  | { readonly kind: 'already_deleted' }

export async function requestAccountDeletion(
  deps: RequestDeletionDeps,
  input: { accountId: string },
): Promise<RequestDeletionResult> {
  const now = deps.now?.() ?? new Date()
  const record = await deps.store.load(input.accountId)
  if (!record) return { kind: 'not_found' }
  if (record.deletedAt) return { kind: 'already_deleted' }

  const releaseAt = domainReleaseAt(now)
  const written = await deps.store.markDeleted({
    accountId: input.accountId,
    at: now,
    domainReleaseAt: releaseAt,
  })
  if (!written) return { kind: 'already_deleted' }

  // First thing after the deletion is written down: the merchant is signed out
  // of every browser, including the one they clicked in. The account row itself
  // survives another week so nobody can re-claim the domain early — and without
  // this, that week is a week in which a deleted account still has working
  // sessions.
  await deps.store.revokeSessions(input.accountId)

  if (record.domainNormalized) {
    await deps.store.purgePreviewCache(record.domainNormalized)
  }

  // Last, so nothing tells three vendors a merchant has gone until the deletion
  // is written down and has stood.
  await deps.store.queueClosure(input.accountId)

  deps.capture?.capture({
    event: ACCOUNT_DELETED_EVENT,
    attribution: accountAttribution(input.accountId, record.domainNormalized ?? undefined),
    properties: { had_subscription: record.stripeSubscriptionId !== null },
  })

  return {
    kind: 'deleted',
    deletedAt: now,
    domainFreeAt: record.domainNormalized ? releaseAt : null,
  }
}

export interface CloseAccountDeps {
  readonly store: AccountLifecycleStore
  readonly billing: SubscriptionCanceller
  readonly revoker: AccessRevoker
  readonly log?: Logger
}

export type CloseAccountResult =
  | {
      readonly kind: 'closed'
      readonly subscriptionCancelled: boolean
      /**
       * Which grants we managed to hand back. Null means there was nothing to
       * hand back; false means the vendor refused and we destroyed the token
       * anyway.
       */
      readonly revoked: { shopify: boolean | null; google: boolean | null }
    }
  /** Nothing to do: no such account, or its deletion was never requested. */
  | { readonly kind: 'skipped'; readonly why: 'not_found' | 'not_deleted' }

/**
 * The vendor half, run as a job and safe to run again.
 *
 * Safe to repeat because each step is: cancelling an already-cancelled
 * subscription is a no-op at Stripe, revoking an already-revoked grant is a
 * no-op at the vendor, and the token delete is a delete. A retry after a
 * half-finished attempt therefore finishes the job rather than repeating its
 * effects.
 */
export async function closeAccount(
  deps: CloseAccountDeps,
  input: { accountId: string },
): Promise<CloseAccountResult> {
  const record = await deps.store.load(input.accountId)
  if (!record) return { kind: 'skipped', why: 'not_found' }
  // The guard that stops this job erasing a live account's grants if it is ever
  // enqueued by mistake.
  if (!record.deletedAt) return { kind: 'skipped', why: 'not_deleted' }

  let subscriptionCancelled = false
  if (record.stripeSubscriptionId) {
    // Deliberately unguarded. A deleted account whose card is still being
    // charged is the worst outcome available here, so a refusal fails the job
    // and it is retried; the tokens below are handed back on the next attempt.
    await deps.billing.cancelNow(record.stripeSubscriptionId)
    subscriptionCancelled = true
  }

  const revoked = {
    shopify: record.shopifyToken
      ? await bestEffort(deps, 'shopify', () => deps.revoker.revokeShopify(record.shopifyToken!))
      : null,
    google: record.googleRefreshToken
      ? await bestEffort(deps, 'google', () =>
          deps.revoker.revokeGoogle(record.googleRefreshToken!),
        )
      : null,
  }

  await deps.store.clearGrants(input.accountId)
  return { kind: 'closed', subscriptionCancelled, revoked }
}

async function bestEffort(
  deps: CloseAccountDeps,
  vendor: 'shopify' | 'google',
  call: () => Promise<void>,
): Promise<boolean> {
  try {
    await call()
    return true
  } catch (error) {
    deps.log?.warn('token_revocation_failed', {
      vendor,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}
