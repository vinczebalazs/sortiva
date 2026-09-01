import {
  activeOpsFlagsForAccount,
  db,
  type Db,
  findAccountById,
  findDomainForAccount,
  findShopifyConnForAccount,
  findSubscriptionForAccount,
  type AccountScope,
} from '@sortiva/db'
import { buildAccountView, type AccountView } from '@sortiva/core'

/**
 * Reads everything the dashboard shell needs, every query scoped by the
 * session's account. Returns null when the session names an account
 * that no longer exists — a deleted account holding a still-valid JWT.
 *
 * No Stripe call anywhere here: entitlement lives in our own `subscriptions`
 * row, written only by the webhook worker, so this page never waits on them.
 */
export async function loadAccountView(
  scope: AccountScope,
  /** The integration test hands in its own isolated database; production uses the pool. */
  injectedDatabase?: Db,
): Promise<AccountView | null> {
  const database = injectedDatabase ?? db()
  const account = await findAccountById(database, scope)
  if (!account || account.deletedAt) return null

  const [domain, subscription, shopify, activeFlags] = await Promise.all([
    findDomainForAccount(database, scope),
    findSubscriptionForAccount(database, scope),
    findShopifyConnForAccount(database, scope),
    activeOpsFlagsForAccount(database, scope),
  ])

  return buildAccountView({
    accountId: account.id,
    email: account.email,
    domain: domain
      ? { normalized: domain.domainNormalized, state: domain.state, platform: domain.platform }
      : null,
    subscription: subscription
      ? {
          status: subscription.status,
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
          currentPeriodEnd: subscription.currentPeriodEnd,
        }
      : null,
    shopify: shopify
      ? { grantedScopes: shopify.grantedScopes, invalidatedAt: shopify.invalidatedAt }
      : null,
    activeFlags,
  })
}
