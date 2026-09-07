import { and, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm'
import type { Db } from '../client'
import {
  accountSettings,
  accounts,
  competitors,
  domains,
  emailSends,
  gscConns,
  gscDaily,
  gscQueryDaily,
  keywords,
  landingRevenueDaily,
  notifications,
  personas,
  previewCache,
  productFamilies,
  products,
  requestCache,
  sessions,
  shopifyConns,
  storePages,
  subscriptions,
  verificationTokens,
  webhookEvents,
} from '../schema'
import type { AccountScope, SystemScope } from '../scope'

/**
 * Ending an account, honouring a store's redaction request, and keeping the
 * database from growing forever.
 *
 * Almost every table hangs off `accounts` with `ON DELETE CASCADE`, so erasing
 * an account is one delete and the database does the rest. Three tables
 * deliberately do not: the completed-work ledger and the spend ledger have no
 * foreign key at all, because a record of paid work must survive the payer, and
 * the preview cache is keyed by domain rather than by account so nothing
 * reaches it — it is deleted by name below.
 */

export interface AccountLifecycleRow {
  accountId: string
  email: string
  domainNormalized: string | null
  stripeSubscriptionId: string | null
  shopifyShopHandle: string | null
  /** Ciphertext. Decryption happens above this layer. */
  shopifyTokenCipher: string | null
  /** Ciphertext. */
  gscTokensCipher: string | null
  deletedAt: Date | null
}

/** Everything ending an account needs, in one read. */
export async function loadAccountLifecycle(
  db: Db,
  scope: AccountScope,
): Promise<AccountLifecycleRow | undefined> {
  const [row] = await db
    .select({
      accountId: accounts.id,
      email: accounts.email,
      deletedAt: accounts.deletedAt,
      domainNormalized: domains.domainNormalized,
      stripeSubscriptionId: subscriptions.stripeSubscriptionId,
      shopifyShopHandle: shopifyConns.shopHandle,
      shopifyTokenCipher: shopifyConns.accessToken,
      gscTokensCipher: gscConns.tokens,
    })
    .from(accounts)
    .leftJoin(domains, eq(domains.accountId, accounts.id))
    .leftJoin(subscriptions, eq(subscriptions.accountId, accounts.id))
    .leftJoin(shopifyConns, eq(shopifyConns.accountId, accounts.id))
    .leftJoin(gscConns, eq(gscConns.accountId, accounts.id))
    .where(eq(accounts.id, scope.accountId))
    .limit(1)
  return row
}

export interface LifecycleStateRow {
  deletedAt: Date | null
  vacationMode: boolean
  subscription: {
    status: 'active' | 'past_due' | 'canceled' | 'incomplete' | 'incomplete_expired'
    cancelAtPeriodEnd: boolean
    currentPeriodEnd: Date | null
  } | null
}

/**
 * The three facts that decide what an account may do right now, in one read.
 *
 * Read together because they are answered together: a dispatcher asking "may
 * this run" would otherwise make three round trips and could see them from
 * three different moments.
 */
export async function readLifecycleState(
  db: Db,
  scope: AccountScope,
): Promise<LifecycleStateRow | undefined> {
  const [row] = await db
    .select({
      deletedAt: accounts.deletedAt,
      vacationMode: accountSettings.vacationMode,
      status: subscriptions.status,
      cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
    })
    .from(accounts)
    .leftJoin(accountSettings, eq(accountSettings.accountId, accounts.id))
    .leftJoin(subscriptions, eq(subscriptions.accountId, accounts.id))
    .where(eq(accounts.id, scope.accountId))
    .limit(1)
  if (!row) return undefined
  return {
    deletedAt: row.deletedAt,
    // No settings row yet means nothing has been switched on, and vacation mode
    // is something a merchant switches on.
    vacationMode: row.vacationMode ?? false,
    subscription: row.status
      ? {
          status: row.status,
          cancelAtPeriodEnd: row.cancelAtPeriodEnd ?? false,
          currentPeriodEnd: row.currentPeriodEnd,
        }
      : null,
  }
}

/**
 * Writes the deletion down: the stamp, the domain's release deadline, and both
 * connections marked dead — in one transaction, so an account that reads as
 * deleted can never still look connected to anything.
 *
 * The two stored tokens survive this write on purpose. Something still has to
 * hand them back to the vendors that issued them, and that runs as a job rather
 * than inside the request; a job cannot be handed a credential through a queue
 * payload, so it re-reads it here. Both are ciphertext at rest, both stop being
 * usable by the product the moment the connection is marked dead, and
 * `clearAccountGrants` deletes them once the vendors have been told.
 *
 * Guarded on the account not already being deleted. False means another request
 * got there first, and the caller must stop.
 */
export async function markAccountDeleted(
  db: Db,
  scope: AccountScope,
  input: { at: Date; domainReleaseAt: Date },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(accounts)
      .set({ deletedAt: input.at })
      .where(and(eq(accounts.id, scope.accountId), isNull(accounts.deletedAt)))
      .returning({ id: accounts.id })
    if (!row) return false

    await tx
      .update(domains)
      .set({ releaseAfter: input.domainReleaseAt, updatedAt: input.at })
      .where(eq(domains.accountId, scope.accountId))

    // Marked dead rather than deleted, so the store handle stops answering
    // "whose is this" for any incoming webhook while the token is still here to
    // be handed back.
    await tx
      .update(shopifyConns)
      .set({ invalidatedAt: input.at })
      .where(and(eq(shopifyConns.accountId, scope.accountId), isNull(shopifyConns.invalidatedAt)))
    await tx
      .update(gscConns)
      .set({ invalidatedAt: input.at })
      .where(and(eq(gscConns.accountId, scope.accountId), isNull(gscConns.invalidatedAt)))
    return true
  })
}

/** Destroys the two stored grants, once the vendors that issued them have been told. */
export async function clearAccountGrants(db: Db, scope: AccountScope): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(shopifyConns).where(eq(shopifyConns.accountId, scope.accountId))
    await tx.delete(gscConns).where(eq(gscConns.accountId, scope.accountId))
  })
}

/** Disposable by design, and the one table no cascade reaches. */
export async function purgePreviewCacheRow(
  db: Db,
  _scope: SystemScope,
  domainNormalized: string,
): Promise<void> {
  await db.delete(previewCache).where(eq(previewCache.domainNormalized, domainNormalized))
}

/**
 * Deleted accounts whose grace window has passed and whose rows may now go.
 *
 * The window is measured from the deletion stamp rather than from the domain's
 * release deadline, so an account that never claimed a domain is erased on the
 * same schedule as one that did.
 */
export async function accountsDueForPurge(
  db: Db,
  _scope: SystemScope,
  input: { before: Date; limit?: number },
): Promise<string[]> {
  const rows = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(isNotNull(accounts.deletedAt), lt(accounts.deletedAt, input.before)))
    .limit(input.limit ?? 100)
  return rows.map((r) => r.id)
}

/**
 * Erases the account. One delete; the cascade takes the domain, the settings,
 * the catalogue, the bell, the mail records and the rest with it.
 *
 * Guarded on the deletion actually having been requested, so a bug in a caller
 * cannot erase a live account.
 */
export async function hardDeleteAccount(db: Db, scope: AccountScope): Promise<boolean> {
  const [row] = await db
    .delete(accounts)
    .where(and(eq(accounts.id, scope.accountId), isNotNull(accounts.deletedAt)))
    .returning({ id: accounts.id })
  return row !== undefined
}

/**
 * Everything that came out of a merchant's Shopify store, erased on their
 * redaction request while the account itself survives.
 *
 * Broader than the raw catalogue on purpose: a persona, a keyword set and a
 * competitor list are all conclusions read off the store's own words and
 * products, so leaving them would leave the store described in our database
 * after being asked to erase it. What is deliberately not touched is everything
 * that did not come from Shopify — the merchant's own account, their billing,
 * and Search Console data, which arrives under a separate grant from Google.
 */
export async function purgeStoreDerived(db: Db, scope: AccountScope): Promise<void> {
  await db.transaction(async (tx) => {
    const id = scope.accountId
    // `product_facts` and `top_products` cascade from `products`; deleting the
    // products is what removes them.
    await tx.delete(products).where(eq(products.accountId, id))
    await tx.delete(productFamilies).where(eq(productFamilies.accountId, id))
    await tx.delete(storePages).where(eq(storePages.accountId, id))
    await tx.delete(landingRevenueDaily).where(eq(landingRevenueDaily.accountId, id))
    await tx.delete(personas).where(eq(personas.accountId, id))
    await tx.delete(keywords).where(eq(keywords.accountId, id))
    await tx.delete(competitors).where(eq(competitors.accountId, id))
    await tx.delete(shopifyConns).where(eq(shopifyConns.accountId, id))
  })
}

/**
 * Which account a store belongs to, whether or not the connection is still
 * live.
 *
 * The ordinary lookup answers with live connections only, which is right for
 * routing a catalogue change. A redaction request is the opposite case: it
 * arrives about two days *after* the uninstall, so by then the connection is
 * always dead and the live-only lookup answers "nobody" — which would mean
 * honouring nothing. Newest first, so a handle that has belonged to two
 * accounts resolves to the most recent.
 */
export async function findAccountByShopHandleIncludingLost(
  db: Db,
  _scope: SystemScope,
  shopHandle: string,
): Promise<{ accountId: string; connectedAt: Date } | undefined> {
  const [row] = await db
    .select({ accountId: shopifyConns.accountId, connectedAt: shopifyConns.connectedAt })
    .from(shopifyConns)
    .where(eq(shopifyConns.shopHandle, shopHandle))
    .orderBy(sql`${shopifyConns.connectedAt} desc`)
    .limit(1)
  return row
}

export interface StoredRedactionRequest {
  webhookId: string
  shopHandle: string
  receivedAt: Date
}

/**
 * Store redaction requests we have been sent, newest first.
 *
 * Reads the delivery's envelope — the store handle, which the receiver copies
 * out of a request header — and never the message body. The body is the
 * vendor's, may contain things we did not ask for, and is not ours to build
 * behaviour on.
 */
export async function storedRedactionRequests(
  db: Db,
  _scope: SystemScope,
  input: { since: Date; limit?: number },
): Promise<StoredRedactionRequest[]> {
  const rows = await db
    .select({
      webhookId: webhookEvents.webhookId,
      shopHandle: sql<string | null>`${webhookEvents.payload} ->> 'shop_handle'`,
      receivedAt: webhookEvents.receivedAt,
    })
    .from(webhookEvents)
    .where(
      and(
        eq(webhookEvents.source, 'shopify'),
        eq(webhookEvents.topic, 'shop/redact'),
        sql`${webhookEvents.receivedAt} >= ${input.since}`,
      ),
    )
    .limit(input.limit ?? 200)
  return rows
    .filter((r): r is typeof r & { shopHandle: string } => Boolean(r.shopHandle))
    .map((r) => ({ webhookId: r.webhookId, shopHandle: r.shopHandle, receivedAt: r.receivedAt }))
}

// ── Retention ───────────────────────────────────────────────────────────────

/**
 * Every prune is "delete rows older than this instant". Re-running one deletes
 * nothing the previous run left behind, which is the whole of the idempotency
 * argument — there is no state to get wrong, only rows that are already gone.
 */

export async function pruneWebhookEvents(
  db: Db,
  _scope: SystemScope,
  before: Date,
): Promise<number> {
  const rows = await db
    .delete(webhookEvents)
    .where(lt(webhookEvents.receivedAt, before))
    .returning({ id: webhookEvents.webhookId })
  return rows.length
}

export async function pruneNotifications(
  db: Db,
  _scope: SystemScope,
  before: Date,
): Promise<number> {
  const rows = await db
    .delete(notifications)
    .where(lt(notifications.createdAt, before))
    .returning({ id: notifications.id })
  return rows.length
}

export async function pruneEmailSends(db: Db, _scope: SystemScope, before: Date): Promise<number> {
  const rows = await db
    .delete(emailSends)
    .where(lt(emailSends.queuedAt, before))
    .returning({ id: emailSends.id })
  return rows.length
}

/** Rows carry their own expiry; nothing here decides how long a cached answer lives. */
export async function pruneExpiredRequestCache(
  db: Db,
  _scope: SystemScope,
  now: Date,
): Promise<number> {
  const rows = await db
    .delete(requestCache)
    .where(lt(requestCache.expiresAt, now))
    .returning({ id: requestCache.cacheKey })
  return rows.length
}

export async function pruneExpiredVerificationTokens(
  db: Db,
  _scope: SystemScope,
  now: Date,
): Promise<number> {
  const rows = await db
    .delete(verificationTokens)
    .where(lt(verificationTokens.expires, now))
    .returning({ token: verificationTokens.token })
  return rows.length
}

/**
 * Sessions that lapsed on their own, with nobody having signed out.
 *
 * Strictly `<`, matching the sign-in links above: a session whose lapse date has
 * not yet arrived is still a session somebody is using, and one whose date is
 * exactly now is already refused at sign-in, so deleting it changes nothing a
 * merchant sees. Counting the deleted rows rather than returning the tokens is
 * deliberate — a token is the credential itself, and a nightly job has no
 * reason to carry a list of them around.
 */
export async function pruneExpiredSessions(
  db: Db,
  _scope: SystemScope,
  now: Date,
): Promise<number> {
  const rows = await db
    .delete(sessions)
    .where(lt(sessions.expires, now))
    .returning({ accountId: sessions.accountId })
  return rows.length
}

/**
 * Search Console history past sixteen months.
 *
 * The date column is a calendar date rather than an instant, so the cutoff is
 * compared as `YYYY-MM-DD`. Google itself only serves sixteen months, so a row
 * deleted here can never be fetched again.
 */
export async function pruneGscDaily(
  db: Db,
  _scope: SystemScope,
  beforeDate: string,
): Promise<number> {
  const rows = await db
    .delete(gscDaily)
    .where(sql`${gscDaily.date} < ${beforeDate}`)
    .returning({ date: gscDaily.date })
  return rows.length
}

export async function pruneGscQueryDaily(
  db: Db,
  _scope: SystemScope,
  beforeDate: string,
): Promise<number> {
  const rows = await db
    .delete(gscQueryDaily)
    .where(sql`${gscQueryDaily.date} < ${beforeDate}`)
    .returning({ date: gscQueryDaily.date })
  return rows.length
}

/** Accounts named by a set of ids, for a sweep that already knows which. */
export async function accountsExist(
  db: Db,
  _scope: SystemScope,
  ids: readonly string[],
): Promise<string[]> {
  if (ids.length === 0) return []
  const rows = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(inArray(accounts.id, [...ids]))
  return rows.map((r) => r.id)
}
