import { and, eq, isNull, lt, lte, sql } from 'drizzle-orm'
import type { Db } from '../client'
import { domains, shopifyConns } from '../schema'
import type { AccountScope, SystemScope } from '../scope'
import { findShopifyConnForAccount, type ShopifyConnRow } from './accounts'

/**
 * One store's Shopify connection.
 *
 * The token column holds ciphertext and never a token: encryption happens above
 * this layer, at the point the process assembles its services, so this package
 * needs no key and a database dump alone yields nothing usable. Every method
 * that reads or writes one account's row takes that account's scope, so a query
 * cannot reach a connection without naming whose it is.
 */

/**
 * Writes the connection, replacing whatever was there.
 *
 * Reconnecting after the app was uninstalled is the ordinary case, so the
 * conflict path clears the invalidation stamp: the row is the *current* state
 * of the connection, not a history of it. Re-running the same successful
 * callback therefore lands on the same row with the same result.
 */
export async function saveShopifyConnection(
  db: Db,
  scope: AccountScope,
  input: {
    shopHandle: string
    /** Already encrypted. This layer never sees a token. */
    accessTokenCipher: string
    accessTokenExpiresAt?: Date | null
    /** Already encrypted, and null for a grant Shopify issued without one. */
    refreshTokenCipher?: string | null
    refreshTokenExpiresAt?: Date | null
    grantedScopes: readonly string[]
    /** The host the storefront actually serves on, as the store reports it. */
    storefrontHost?: string | null
    /** Set on a grant that carries permission to publish; never cleared once set. */
    publishGrantedAt?: Date | null
  },
): Promise<ShopifyConnRow> {
  const tokens = {
    accessToken: input.accessTokenCipher,
    accessTokenExpiresAt: input.accessTokenExpiresAt ?? null,
    refreshToken: input.refreshTokenCipher ?? null,
    refreshTokenExpiresAt: input.refreshTokenExpiresAt ?? null,
  }
  const [row] = await db
    .insert(shopifyConns)
    .values({
      accountId: scope.accountId,
      shopHandle: input.shopHandle,
      grantedScopes: [...input.grantedScopes],
      ...tokens,
      ...(input.storefrontHost === undefined ? {} : { storefrontHost: input.storefrontHost }),
      ...(input.publishGrantedAt ? { publishGrantedAt: input.publishGrantedAt } : {}),
    })
    .onConflictDoUpdate({
      target: shopifyConns.accountId,
      set: {
        shopHandle: input.shopHandle,
        grantedScopes: [...input.grantedScopes],
        connectedAt: new Date(),
        invalidatedAt: null,
        ...tokens,
        // Left alone when the caller says nothing, so a reconnect that has not
        // re-read the store keeps the host it already knew.
        ...(input.storefrontHost === undefined ? {} : { storefrontHost: input.storefrontHost }),
        // Only ever set. "This merchant once allowed publishing" stays true
        // after a connection is lost, which is what lets a reconnect keep a
        // write grant instead of throwing it away as unasked-for.
        ...(input.publishGrantedAt ? { publishGrantedAt: input.publishGrantedAt } : {}),
      },
    })
    .returning()
  if (!row) throw new Error('failed to save the Shopify connection')
  return row
}

/**
 * Records what the store says about itself: the host it serves on, and its
 * name.
 *
 * Both are learned by asking Shopify after a connection is made, and both are
 * needed later at moments when asking again would be a network call in the
 * middle of something else — building a published article's address, and
 * putting a byline on it.
 */
export async function recordStoreIdentity(
  db: Db,
  scope: AccountScope,
  input: { storefrontHost?: string; shopName?: string },
): Promise<void> {
  const patch = {
    ...(input.storefrontHost === undefined ? {} : { storefrontHost: input.storefrontHost }),
    ...(input.shopName === undefined ? {} : { shopName: input.shopName }),
  }
  if (Object.keys(patch).length === 0) return
  await db.update(shopifyConns).set(patch).where(eq(shopifyConns.accountId, scope.accountId))
}

/** The stored ciphertext, for a caller that is about to decrypt it and make a call. */
export async function readShopifyTokenCipher(
  db: Db,
  scope: AccountScope,
): Promise<string | undefined> {
  const [row] = await db
    .select({ accessToken: shopifyConns.accessToken })
    .from(shopifyConns)
    .where(eq(shopifyConns.accountId, scope.accountId))
    .limit(1)
  return row?.accessToken
}

/**
 * Stamps the moment Shopify stopped accepting our token, and answers with the
 * stamp now on the row.
 *
 * Stamping a connection that is already known to be broken leaves the original
 * moment alone. That is what makes the reconnect notification send once: its
 * dedupe key carries this timestamp, so a worker that runs twice computes the
 * same key, while a store that reconnects and later breaks again gets a new one.
 */
export async function markShopifyConnectionInvalid(
  db: Db,
  scope: AccountScope,
  at: Date,
): Promise<Date | undefined> {
  const [row] = await db
    .update(shopifyConns)
    .set({ invalidatedAt: at })
    .where(
      and(
        eq(shopifyConns.accountId, scope.accountId),
        isNull(shopifyConns.invalidatedAt),
        // Not a connection made *after* the refusal being reported. A merchant
        // who reconnects while a job that failed on the old token is still
        // winding down would otherwise be told immediately that their brand new
        // connection is broken.
        lte(shopifyConns.connectedAt, at),
      ),
    )
    .returning({ invalidatedAt: shopifyConns.invalidatedAt })
  if (row?.invalidatedAt) return row.invalidatedAt

  const existing = await findShopifyConnForAccount(db, scope)
  return existing?.invalidatedAt ?? undefined
}

/**
 * Which account holds a given store *right now*, if any.
 *
 * Deliberately unscoped: a webhook from Shopify names the store and nothing
 * else, so answering "whose is this" is the whole question.
 *
 * Only live connections are considered, and that is what keeps the answer
 * single: since wave 4 the handle is unique among live rows only, so a store
 * that was connected, lost, and connected again by someone else has two rows.
 * Answering with the abandoned one would route an uninstall — or any other
 * store-addressed event — to an account that no longer has that store, silently
 * doing nothing to the account that does. A store whose only row is dead
 * answers "nobody", which is right: the connection is already recorded as lost.
 */
export async function findAccountByShopHandle(
  db: Db,
  _scope: SystemScope,
  shopHandle: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ accountId: shopifyConns.accountId })
    .from(shopifyConns)
    .where(and(eq(shopifyConns.shopHandle, shopHandle), isNull(shopifyConns.invalidatedAt)))
    .limit(1)
  return row?.accountId
}

/**
 * Whether this account has a connection at all — which is what tells the two
 * `awaiting_shopify_auth` screens apart. No row means the merchant has never
 * connected and sees the invitation; a row with an invalidation stamp means the
 * connection they had was lost and they see the reconnect banner.
 */
export async function shopifyConnectionState(
  db: Db,
  scope: AccountScope,
): Promise<'never_connected' | 'connected' | 'lost'> {
  const row = await findShopifyConnForAccount(db, scope)
  if (!row) return 'never_connected'
  return row.invalidatedAt ? 'lost' : 'connected'
}

/**
 * Records which platform detection found. Written once per store, alongside the
 * state transition that follows from it.
 */
export async function setDomainPlatform(
  db: Db,
  scope: AccountScope,
  platform: 'shopify' | 'custom_unsupported',
): Promise<void> {
  await db
    .update(domains)
    .set({ platform, updatedAt: sql`now()` })
    .where(eq(domains.accountId, scope.accountId))
}

/**
 * Stores that have been asked to connect Shopify and have not, long enough ago
 * to be worth a reminder.
 *
 * Only stores that have *never* connected: a store whose connection was lost
 * later is a different conversation and gets its own message when it happens.
 *
 * Deliberately unscoped — a sweep's whole job is to look across every account —
 * and it reads nothing but the domain and the account it belongs to.
 */
export async function storesAwaitingShopifyAuth(
  db: Db,
  _scope: SystemScope,
  waitingSince: Date,
): Promise<{ accountId: string; domainNormalized: string }[]> {
  return db
    .select({ accountId: domains.accountId, domainNormalized: domains.domainNormalized })
    .from(domains)
    .leftJoin(shopifyConns, eq(shopifyConns.accountId, domains.accountId))
    .where(
      and(
        eq(domains.state, 'awaiting_shopify_auth'),
        eq(domains.platform, 'shopify'),
        isNull(shopifyConns.accountId),
        lt(domains.updatedAt, waitingSince),
      ),
    )
}
