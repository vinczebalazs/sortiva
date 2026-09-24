import { eq } from 'drizzle-orm'
import {
  ShopifyGrantGone,
  type ShopifyAccessGrant,
  type ShopifyAuth,
  type ShopifyTokenRenewer,
} from '@sortiva/core'
import type { Db } from '../client'
import { shopifyConns } from '../schema'

/**
 * Where a usable Shopify token comes from.
 *
 * Shopify's tokens last an hour. A catalogue walk can last longer than that, so
 * a token is asked for per request rather than held: this hands out one that is
 * good now, and renews it when it is not.
 *
 * Renewals are serialised per store on purpose. Shopify replaces the refresh
 * token on every renewal and retires the old one the moment the new one is
 * used, and warns against renewing the same store twice at once — two workers
 * doing it together would leave one of them holding a token Shopify has already
 * forgotten. The row is locked for the length of a renewal, and whoever waits
 * for the lock finds the token the winner just stored and uses that instead of
 * renewing again.
 */

export interface ShopifyTokenCrypto {
  encrypt(plain: string): string
  decrypt(cipher: string): string
}

export interface ShopifyAuthSourceOptions {
  /**
   * How long before expiry a token is renewed rather than risked. A token that
   * dies mid-walk turns a working sync into a reconnect prompt for no reason.
   */
  renewMarginMs?: number
  now?: () => Date
}

const DEFAULT_RENEW_MARGIN_MS = 5 * 60 * 1000

export interface ShopifyAuthSource {
  /**
   * How to reach one store, or undefined when there is no connection to reach
   * it with — never connected, or lost and not yet mended.
   */
  authFor(accountId: string): Promise<ShopifyAuth | undefined>
}

export function makeShopifyAuthSource(
  database: Db,
  crypto: ShopifyTokenCrypto,
  renewer: ShopifyTokenRenewer,
  options: ShopifyAuthSourceOptions = {},
): ShopifyAuthSource {
  const margin = options.renewMarginMs ?? DEFAULT_RENEW_MARGIN_MS
  const now = options.now ?? (() => new Date())

  /**
   * Renews under the row's own lock, and only if it still needs renewing.
   *
   * `rejected` names the token the caller found wanting. Another worker may
   * have renewed in the meantime, or the merchant may have reconnected: in both
   * cases the stored token is already a different one and is handed back
   * without spending a renewal.
   */
  async function renew(
    accountId: string,
    reason: { rejected?: string; expiringBefore?: Date },
  ): Promise<string | undefined> {
    return database.transaction(async (tx) => {
      const [row] = await tx
        .select({
          shopHandle: shopifyConns.shopHandle,
          accessToken: shopifyConns.accessToken,
          accessTokenExpiresAt: shopifyConns.accessTokenExpiresAt,
          refreshToken: shopifyConns.refreshToken,
          refreshTokenExpiresAt: shopifyConns.refreshTokenExpiresAt,
          invalidatedAt: shopifyConns.invalidatedAt,
        })
        .from(shopifyConns)
        .where(eq(shopifyConns.accountId, accountId))
        .limit(1)
        .for('update')
      if (!row) return undefined

      const current = crypto.decrypt(row.accessToken)
      const stillWanted =
        reason.rejected !== undefined
          ? current === reason.rejected
          : row.accessTokenExpiresAt !== null &&
            reason.expiringBefore !== undefined &&
            row.accessTokenExpiresAt.getTime() <= reason.expiringBefore.getTime()
      if (!stillWanted) return current

      if (!row.refreshToken) {
        // A token from before Shopify required renewable ones, or a connection
        // whose renewal Shopify already refused. Either way there is nothing to
        // renew with, and the merchant has to grant permission again.
        return reason.rejected === undefined ? current : undefined
      }
      if (row.refreshTokenExpiresAt && row.refreshTokenExpiresAt.getTime() <= now().getTime()) {
        return undefined
      }

      const grant = await renewer.refreshAccess({
        shop: row.shopHandle,
        refreshToken: crypto.decrypt(row.refreshToken),
      })
      await tx
        .update(shopifyConns)
        .set(tokenColumns(crypto, grant))
        .where(eq(shopifyConns.accountId, accountId))
      return grant.accessToken
    })
  }

  return {
    async authFor(accountId: string): Promise<ShopifyAuth | undefined> {
      const [row] = await database
        .select({
          shopHandle: shopifyConns.shopHandle,
          invalidatedAt: shopifyConns.invalidatedAt,
        })
        .from(shopifyConns)
        .where(eq(shopifyConns.accountId, accountId))
        .limit(1)
      if (!row || row.invalidatedAt !== null) return undefined

      return {
        shop: row.shopHandle,

        async accessToken(): Promise<string> {
          const [held] = await database
            .select({
              accessToken: shopifyConns.accessToken,
              accessTokenExpiresAt: shopifyConns.accessTokenExpiresAt,
            })
            .from(shopifyConns)
            .where(eq(shopifyConns.accountId, accountId))
            .limit(1)
          if (!held) throw new ShopifyGrantGone(row.shopHandle, 'the connection is gone')

          const deadline = new Date(now().getTime() + margin)
          if (held.accessTokenExpiresAt === null || held.accessTokenExpiresAt > deadline) {
            return crypto.decrypt(held.accessToken)
          }
          const renewed = await renew(accountId, { expiringBefore: deadline })
          if (!renewed) {
            throw new ShopifyGrantGone(row.shopHandle, 'the token expired and could not be renewed')
          }
          return renewed
        },

        async refreshed(rejected: string): Promise<string | undefined> {
          try {
            return await renew(accountId, { rejected })
          } catch (error) {
            // A grant Shopify will not renew is an answer, not a fault: the
            // caller stops and the merchant is asked to reconnect. Anything
            // else — a network that dropped, Shopify having a bad minute — is
            // raised, because the old refresh token still works and the job
            // should come back rather than declare the connection dead.
            if (error instanceof ShopifyGrantGone) return undefined
            throw error
          }
        },
      }
    },
  }
}

/** The token half of a connection row, encrypted. */
export function tokenColumns(
  crypto: ShopifyTokenCrypto,
  grant: ShopifyAccessGrant,
): {
  accessToken: string
  accessTokenExpiresAt: Date | null
  refreshToken: string | null
  refreshTokenExpiresAt: Date | null
} {
  return {
    accessToken: crypto.encrypt(grant.accessToken),
    accessTokenExpiresAt: grant.expiresAt,
    refreshToken: grant.refreshToken === null ? null : crypto.encrypt(grant.refreshToken),
    refreshTokenExpiresAt: grant.refreshTokenExpiresAt,
  }
}
