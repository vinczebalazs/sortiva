import {
  accountAttribution,
  recordConnectionLost,
  type Logger,
  type NotificationEmitter,
} from '@sortiva/core'
import {
  accountScope,
  findAccountByShopHandle,
  findDomainForAccount,
  findShopifyConnForAccount,
  markShopifyConnectionInvalid,
  setDomainPlatform,
  systemScope,
  transitionDomainState,
  type Db,
} from '@sortiva/db'

/**
 * What happens when Shopify rejects our token while we are posting.
 *
 * Publishing used to swallow this: the article failed, the store was left
 * looking connected, and the merchant was told nothing — every morning, for
 * ever. The product already knows how to handle a dead token, because the
 * onboarding path has handled it since the beginning: the store is marked as
 * needing to be reconnected, its onboarding moves to the reconnect screen, and
 * a notification goes out that raises the banner and the email. This calls that
 * same path rather than a second one of its own, so a merchant whose connection
 * dies at the publish hour is told exactly what a merchant whose connection
 * dies during a catalogue read is told.
 *
 * Read access is never revoked by this: everything already written for the
 * merchant stays visible. It is a pause with a visible reason, which is what
 * the product promises instead of quietly degrading.
 */
export async function raiseShopifyReconnect(
  db: Db,
  input: { accountId: string; at: Date; notifications?: NotificationEmitter; logger?: Logger },
): Promise<void> {
  const domain = await findDomainForAccount(db, accountScope(input.accountId))
  await recordConnectionLost(
    {
      domains: {
        findAccountByShopHandle: (shopHandle) =>
          findAccountByShopHandle(
            db,
            systemScope('a rejected publishing token names the store and nothing else'),
            shopHandle,
          ),
        setPlatform: async (accountId, platform) => {
          await setDomainPlatform(db, accountScope(accountId), platform)
        },
        transition: async (accountId, from, to) =>
          (await transitionDomainState(db, accountScope(accountId), [...from], to))?.state,
        read: async (accountId) => (await findDomainForAccount(db, accountScope(accountId)))?.state,
      },
      connections: {
        read: async (accountId) => {
          const row = await findShopifyConnForAccount(db, accountScope(accountId))
          if (!row) return undefined
          return {
            accountId: row.accountId,
            shopHandle: row.shopHandle,
            grantedScopes: row.grantedScopes,
            connectedAt: row.connectedAt,
            invalidatedAt: row.invalidatedAt,
          }
        },
        markInvalid: async (accountId, at) =>
          (await markShopifyConnectionInvalid(db, accountScope(accountId), at)) ?? at,
      },
      ...(input.notifications ? { notifications: input.notifications } : {}),
    },
    {
      accountId: input.accountId,
      at: input.at,
      attribution: accountAttribution(input.accountId, domain?.domainNormalized),
    },
  )
  input.logger?.warn('publish_connection_lost', { account_id: input.accountId })
}
