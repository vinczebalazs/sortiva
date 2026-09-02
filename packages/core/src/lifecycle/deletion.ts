import { accountAttribution, type PosthogCapture } from '../contracts/analytics'
import type { Logger } from '../observability/logger'
import type {
  AccessRevoker,
  AccountLifecycleStore,
  SubscriptionCanceller,
} from './ports'
import { domainReleaseAt } from './retention'

/**
 * A merchant asking to be deleted, done in the order that makes each step safe
 * to lose.
 *
 * The order is the whole design:
 *
 * 1. **Stop the money first.** Cancelling the subscription is the one step
 *    whose failure a merchant would rightly be angry about, so it happens
 *    before anything else and, if it throws, nothing else happens either — the
 *    account stays live and the request fails loudly. A deletion that silently
 *    left a card being charged is the worst outcome available here.
 * 2. **Hand the grants back**, best-effort. A vendor being down is not a reason
 *    to refuse someone's deletion, and the tokens are destroyed locally in the
 *    next step regardless, so the worst case is a grant that stays listed on
 *    the merchant's side until they remove it themselves. Recorded, not raised.
 * 3. **Write the deletion down** — the stamp, the domain's release deadline and
 *    the removal of both stored tokens, in one transaction. This is the point
 *    of no return: from here the account reads as deleted everywhere.
 * 4. **Drop the preview row**, which is keyed by domain rather than by account
 *    and so is the one thing no cascade reaches.
 *
 * What deliberately does not happen here: erasing the account's rows. That waits
 * for the sweep, because the domain row is a child of the account row and
 * erasing the parent now would free the domain the same hour — the exact thing
 * the seven-day window exists to prevent.
 */

export const ACCOUNT_DELETED_EVENT = 'account_deleted'

export interface DeleteAccountDeps {
  readonly store: AccountLifecycleStore
  readonly billing: SubscriptionCanceller
  readonly revoker: AccessRevoker
  readonly capture?: Pick<PosthogCapture, 'capture'>
  readonly log?: Logger
  readonly now?: () => Date
}

export type DeleteAccountResult =
  | {
      readonly kind: 'deleted'
      readonly deletedAt: Date
      /** When the domain becomes claimable again. Null when none was claimed. */
      readonly domainFreeAt: Date | null
      readonly subscriptionCancelled: boolean
      /** Which grants we managed to hand back. A false here is recorded, never fatal. */
      readonly revoked: { shopify: boolean | null; google: boolean | null }
    }
  | { readonly kind: 'not_found' }
  /** Already deleted, or another request won the guarded update. Answered as success. */
  | { readonly kind: 'already_deleted' }

export async function deleteAccount(
  deps: DeleteAccountDeps,
  input: { accountId: string },
): Promise<DeleteAccountResult> {
  const now = deps.now?.() ?? new Date()
  const record = await deps.store.load(input.accountId)
  if (!record) return { kind: 'not_found' }
  if (record.deletedAt) return { kind: 'already_deleted' }

  let subscriptionCancelled = false
  if (record.stripeSubscriptionId) {
    // Deliberately unguarded: if this throws, the whole request fails and the
    // account is untouched. Better a merchant who has to try again than a
    // merchant whose account is gone and whose card is still being charged.
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

  const releaseAt = domainReleaseAt(now)
  const written = await deps.store.markDeleted({
    accountId: input.accountId,
    at: now,
    domainReleaseAt: releaseAt,
  })
  if (!written) return { kind: 'already_deleted' }

  if (record.domainNormalized) {
    await deps.store.purgePreviewCache(record.domainNormalized)
  }

  deps.capture?.capture({
    event: ACCOUNT_DELETED_EVENT,
    attribution: accountAttribution(input.accountId, record.domainNormalized ?? undefined),
    properties: {
      subscription_cancelled: subscriptionCancelled,
      // Words rather than a nullable boolean: "we had no connection to hand
      // back" and "we tried and the vendor refused" are different facts, and an
      // analytics property may not be null.
      shopify_grant: grantOutcome(revoked.shopify),
      google_grant: grantOutcome(revoked.google),
    },
  })

  return {
    kind: 'deleted',
    deletedAt: now,
    domainFreeAt: record.domainNormalized ? releaseAt : null,
    subscriptionCancelled,
    revoked,
  }
}

async function bestEffort(
  deps: DeleteAccountDeps,
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

function grantOutcome(result: boolean | null): 'none' | 'revoked' | 'failed' {
  if (result === null) return 'none'
  return result ? 'revoked' : 'failed'
}
