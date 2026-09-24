import {
  accountScope,
  findAccountByShopHandle,
  findDomainForAccount,
  findShopifyConnForAccount,
  makeShopifyAuthSource,
  markShopifyConnectionInvalid,
  recordStoreIdentity,
  saveShopifyConnection,
  setDomainPlatform,
  systemScope,
  transitionDomainState,
  type Database,
} from '@sortiva/db'
import {
  SHOPIFY_PUBLISH_SCOPE,
  type DomainState,
  type ShopifyAccessGrant,
  type ShopifyAuth,
  type ShopifyTokenRenewer,
  type StoreConnection,
  type StoreDomainStore,
} from '@sortiva/core'
import type { ConnectionStore } from '@sortiva/jobs/ingestion/deps'
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
  save(
    input: { accountId: string; shopHandle: string; storefrontHost?: string | null; shopName?: string | null } & ShopifyAccessGrant,
  ): Promise<StoreConnection>
}

export function makeConnectionStore(
  database: Database,
  cipher: TokenCipher,
  renewer: ShopifyTokenRenewer,
): ConnectionStoreWithSave {
  // Tokens last an hour and renew themselves; the source is what decides when,
  // and serialises renewals so two workers cannot spend the same refresh token.
  const auth = makeShopifyAuthSource(database, cipher, renewer)

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
        publishGrantedAt: row.publishGrantedAt,
        storefrontHost: row.storefrontHost,
      }
    },

    authFor(accountId: string): Promise<ShopifyAuth | undefined> {
      return auth.authFor(accountId)
    },

    async save(input): Promise<StoreConnection> {
      const row = await saveShopifyConnection(database, accountScope(input.accountId), {
        shopHandle: input.shopHandle,
        grantedScopes: input.grantedScopes,
        ...tokenCiphers(cipher, input),
        ...(input.storefrontHost === undefined ? {} : { storefrontHost: input.storefrontHost }),
        ...(input.shopName === undefined ? {} : { shopName: input.shopName }),
        // A grant that carries publishing records that the merchant allowed it,
        // which outlives this token and every later reconnect.
        ...(input.grantedScopes.includes(SHOPIFY_PUBLISH_SCOPE)
          ? { publishGrantedAt: new Date() }
          : {}),
      })
      return {
        accountId: row.accountId,
        shopHandle: row.shopHandle,
        grantedScopes: row.grantedScopes,
        connectedAt: row.connectedAt,
        invalidatedAt: row.invalidatedAt,
        publishGrantedAt: row.publishGrantedAt,
        storefrontHost: row.storefrontHost,
      }
    },

    async recordStoreIdentity(
      accountId: string,
      identity: { storefrontHost?: string; shopName?: string },
    ): Promise<void> {
      await recordStoreIdentity(database, accountScope(accountId), identity)
    },

    async markInvalid(accountId: string, at: Date): Promise<Date> {
      const stamped = await markShopifyConnectionInvalid(database, accountScope(accountId), at)
      return stamped ?? at
    },
  }
}

/** The token half of a grant, encrypted for storage. */
function tokenCiphers(cipher: TokenCipher, grant: ShopifyAccessGrant) {
  return {
    accessTokenCipher: cipher.encrypt(grant.accessToken),
    accessTokenExpiresAt: grant.expiresAt,
    refreshTokenCipher: grant.refreshToken === null ? null : cipher.encrypt(grant.refreshToken),
    refreshTokenExpiresAt: grant.refreshTokenExpiresAt,
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
