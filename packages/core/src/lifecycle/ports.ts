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
   * Stamps the deletion, sets the domain's release deadline, and clears both
   * stored tokens — in one transaction, because a token we have told the vendor
   * to forget must not still be sitting in our database if the rest fails.
   *
   * Guarded on the account not already being deleted: false means somebody
   * else got there first and this request should stop rather than re-run the
   * vendor calls.
   */
  markDeleted(input: {
    accountId: string
    at: Date
    domainReleaseAt: Date
  }): Promise<boolean>
  /** The logged-out preview's row for this domain, which §14.6 says goes too. */
  purgePreviewCache(domainNormalized: string): Promise<void>
}

/** Cancelling now, not at period end: a deleted account is not billed again. */
export interface SubscriptionCanceller {
  cancelNow(subscriptionId: string): Promise<void>
}

/**
 * Handing an access grant back to the vendor that issued it.
 *
 * Both revocations are best-effort by design. A vendor that is down, or a grant
 * the merchant already removed from their own side, must not stop us deleting
 * the account — the merchant asked to leave. What must not happen is keeping
 * the token, so the local clear-down runs either way and the failure is
 * recorded rather than raised.
 */
export interface AccessRevoker {
  revokeShopify(input: { shopHandle: string; accessToken: string }): Promise<void>
  revokeGoogle(refreshToken: string): Promise<void>
}
