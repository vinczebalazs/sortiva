import {
  accountScope,
  findAccountByShopHandle,
  findDomainForAccount,
  findShopifyConnForAccount,
  markShopifyConnectionInvalid,
  readShopifyTokenCipher,
  saveShopifyConnection,
  setDomainPlatform,
  systemScope,
  transitionDomainState,
  type Database,
} from '@sortiva/db'
import type { DomainState, StoreConnection, StoreDomainStore } from '@sortiva/core'
import type { ConnectionStore } from '@sortiva/jobs'
import type { TokenCipher } from '@sortiva/providers'

/**
 * Where the store-connection ports meet Postgres and the token cipher.
 *
 * `packages/core` and the ingestion steps own no persistence and no key; this
 * is the one place that knows both. Tokens are decrypted here, at the point a
 * caller is about to use one, and never earlier.
 */

/**
 * The database handle and the cipher are arguments rather than something this
 * module reaches for. Naming concrete infrastructure is the job of exactly one
 * file per process; this one only binds ports to repositories, and every
 * repository it calls already names the account it acts for.
 */
export interface ConnectionStoreWithSave extends ConnectionStore {
  save(input: {
    accountId: string
    shopHandle: string
    accessToken: string
    grantedScopes: readonly string[]
  }): Promise<StoreConnection>
}

export function makeConnectionStore(
  database: Database,
  cipher: TokenCipher,
): ConnectionStoreWithSave {

  return {
    async read(accountId: string): Promise<StoreConnection | undefined> {
      const row = await findShopifyConnForAccount(database, accountScope(accountId))
      if (!row) return undefined
      return {
        accountId: row.accountId,
        shopHandle: row.shopHandle,
        grantedScopes: row.grantedScopes,
        connectedAt: row.connectedAt,
        invalidatedAt: row.invalidatedAt,
      }
    },

    async readToken(accountId: string): Promise<string | undefined> {
      const stored = await readShopifyTokenCipher(database, accountScope(accountId))
      return stored ? cipher.decrypt(stored) : undefined
    },

    async save(input): Promise<StoreConnection> {
      const row = await saveShopifyConnection(database, accountScope(input.accountId), {
        shopHandle: input.shopHandle,
        accessTokenCipher: cipher.encrypt(input.accessToken),
        grantedScopes: input.grantedScopes,
      })
      return {
        accountId: row.accountId,
        shopHandle: row.shopHandle,
        grantedScopes: row.grantedScopes,
        connectedAt: row.connectedAt,
        invalidatedAt: row.invalidatedAt,
      }
    },

    async markInvalid(accountId: string, at: Date): Promise<Date> {
      const stamped = await markShopifyConnectionInvalid(database, accountScope(accountId), at)
      return stamped ?? at
    },
  }
}

export interface DomainStoreWithDomain extends StoreDomainStore {
  readNormalized(accountId: string): Promise<string | undefined>
}

export function makeDomainStore(database: Database): DomainStoreWithDomain {
  return {
    async findAccountByShopHandle(shopHandle: string): Promise<string | undefined> {
      return findAccountByShopHandle(
        database,
        systemScope('a Shopify webhook names the store and nothing else'),
        shopHandle,
      )
    },

    async setPlatform(accountId, platform): Promise<void> {
      await setDomainPlatform(database, accountScope(accountId), platform)
    },

    async transition(accountId, from, to): Promise<DomainState | undefined> {
      const row = await transitionDomainState(database, accountScope(accountId), [...from], to)
      return row?.state
    },

    async read(accountId): Promise<DomainState | undefined> {
      const row = await findDomainForAccount(database, accountScope(accountId))
      return row?.state
    },

    async readNormalized(accountId): Promise<string | undefined> {
      const row = await findDomainForAccount(database, accountScope(accountId))
      return row?.domainNormalized
    },
  }
}
