/**
 * What ending an account, or a store relationship, needs from the world.
 *
 * Ports rather than clients: deleting an account touches a payment processor,
 * two OAuth providers and half the database, and the only way to test the order
 * those happen in — and what happens when one of them fails — is to be able to
 * hand it fakes.
 */

export interface AccountLifecycleRecord {
  readonly accountId: string
  readonly email: string
  /** Null until the merchant has claimed one. */
  readonly domainNormalized: string | null
  /** Null when they never reached Checkout. */
  readonly stripeSubscriptionId: string | null
  /** Already decrypted by the caller; this layer never sees ciphertext. */
  readonly shopifyToken: { shopHandle: string; accessToken: string } | null
  /** Google's refresh token, decrypted. */
  readonly googleRefreshToken: string | null
  /** Set once deletion has been requested; a second request is a no-op. */
  readonly deletedAt: Date | null
}

export interface AccountLifecycleStore {
  load(accountId: string): Promise<AccountLifecycleRecord | undefined>
  /**
   * Stamps the deletion, sets the domain's release deadline, and marks both
   * connections dead — in one transaction, so an account that reads as deleted
   * can never still look connected to anything.
   *
   * The stored tokens survive this write, because something still has to hand
   * them back to the vendors that issued them. They are ciphertext at rest, they
   * are unusable by the product from this moment, and the closing step below
   * deletes them.
   *
   * Guarded on the account not already being deleted: false means somebody else
   * got there first and this request should stop.
   */
  markDeleted(input: {
    accountId: string
    at: Date
    domainReleaseAt: Date
  }): Promise<boolean>
  /**
   * Ends every signed-in browser this account has, and answers how many there
   * were.
   *
   * Separate from the erase a week later, and that is the point. The rows do
   * eventually go with the account row, but a merchant who has just asked to be
   * deleted has to be signed out *now* — otherwise the browser they clicked in,
   * and every other one they were ever signed in on, keeps working for another
   * week.
   */
  revokeSessions(accountId: string): Promise<number>
  /** The logged-out preview's row for this domain, which goes too. */
  purgePreviewCache(domainNormalized: string): Promise<void>
  /**
   * Asks for the vendor half — cancel the subscription, hand both grants back.
   *
   * A port rather than a direct call because the request that deletes an
   * account has no business holding a database handle or knowing what a queue
   * is, and because the queueing has to happen through the same handle the
   * deletion was written with.
   */
  queueClosure(accountId: string): Promise<void>
  /** Removes the two stored grants, once the vendors have been told. */
  clearGrants(accountId: string): Promise<void>
}

/**
 * Handing an access grant back to the vendor that issued it.
 *
 * Both revocations are best-effort by design. A vendor that is down, or a grant
 * the merchant already removed from their own side, must not stop us finishing
 * a deletion — and the tokens are destroyed either way, both by the closing step
 * and by the erase a week later.
 */
export interface AccessRevoker {
  revokeShopify(input: { shopHandle: string; accessToken: string }): Promise<void>
  revokeGoogle(refreshToken: string): Promise<void>
}
