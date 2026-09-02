import type { AccountLifecycleStore } from '@sortiva/core'
import { db, type Db } from '../client'
import {
  clearAccountGrants,
  loadAccountLifecycle,
  markAccountDeleted,
  purgePreviewCacheRow,
} from '../repositories/lifecycle'
import { accountScope, systemScope } from '../scope'

/**
 * Binds account deletion to this deployment's database.
 *
 * The two stored grants are ciphertext in the database and plain tokens by the
 * time a vendor sees them, so decryption sits between: this port hands the
 * caller what it holds and a `TokenCipher` above turns it into something a
 * revoke endpoint will accept.
 */
export interface AccountLifecycleStoreOptions {
  database?: Db
  /**
   * Turns a stored token back into a usable one. Left out in tests that do not
   * care about the vendor calls, in which case the ciphertext is passed through
   * and the fake revoker never looks at it.
   */
  decrypt?: (cipher: string) => string
}

export function makeAccountLifecycleStore(
  options: AccountLifecycleStoreOptions = {},
): AccountLifecycleStore {
  const database = (): Db => options.database ?? db()
  const open = (cipher: string): string => (options.decrypt ? options.decrypt(cipher) : cipher)

  return {
    async load(accountId) {
      const row = await loadAccountLifecycle(database(), accountScope(accountId))
      if (!row) return undefined
      return {
        accountId: row.accountId,
        email: row.email,
        domainNormalized: row.domainNormalized,
        stripeSubscriptionId: row.stripeSubscriptionId,
        shopifyToken:
          row.shopifyShopHandle && row.shopifyTokenCipher
            ? {
                shopHandle: row.shopifyShopHandle,
                accessToken: open(row.shopifyTokenCipher),
              }
            : null,
        googleRefreshToken: row.gscTokensCipher ? open(row.gscTokensCipher) : null,
        deletedAt: row.deletedAt,
      }
    },

    markDeleted(input) {
      return markAccountDeleted(database(), accountScope(input.accountId), {
        at: input.at,
        domainReleaseAt: input.domainReleaseAt,
      })
    },

    clearGrants(accountId) {
      return clearAccountGrants(database(), accountScope(accountId))
    },

    purgePreviewCache(domainNormalized) {
      return purgePreviewCacheRow(
        database(),
        systemScope('the preview cache is keyed by domain, so no account scope reaches it'),
        domainNormalized,
      )
    },
  }
}
