import type { DomainState } from '../account/view'
import type { EventAttribution } from '../contracts/analytics'
import type { NotificationEmitter } from '../contracts/opportunities'
import type { StoreConnection } from './ports'

/**
 * What happens to a store when its connection breaks, and what happens when it
 * is made.
 *
 * Two events reach us and mean the same thing: Shopify rejects a token we hold
 * (401/403 on any call), and Shopify tells us the app was uninstalled. Both end
 * with the merchant being asked to reconnect and with new work stopped —
 * generation, publishing and sync. **Read access is never revoked**: everything
 * we already made for them stays visible, so this is a pause, not a lockout.
 */

/** The domain-row writes connecting a store performs, each a guarded transition. */
export interface StoreDomainStore {
  /** The account whose domain this shop handle belongs to, or undefined. */
  findAccountByShopHandle(shopHandle: string): Promise<string | undefined>
  /** Records which platform detection found. */
  setPlatform(accountId: string, platform: 'shopify' | 'custom_unsupported'): Promise<void>
  /**
   * `UPDATE … WHERE state = expected`. Returns undefined when the guard matched
   * no rows, which the caller must read as "someone else moved this store" and
   * stop — never as a failure to retry.
   */
  transition(accountId: string, from: readonly DomainState[], to: DomainState): Promise<DomainState | undefined>
  read(accountId: string): Promise<DomainState | undefined>
}

export interface ConnectionLifecycleDeps {
  readonly domains: StoreDomainStore
  readonly connections: {
    read(accountId: string): Promise<StoreConnection | undefined>
    /**
     * Stamps the moment Shopify rejected the token, and returns the stamp that
     * is now on the row. Stamping an already-invalid connection leaves the
     * original moment alone: a retried worker must arrive at the same answer as
     * the first, or the notification below would be sent twice.
     */
     markInvalid(accountId: string, at: Date): Promise<Date>
  }
  readonly notifications?: NotificationEmitter
}

/**
 * States a broken connection may interrupt. A store already parked as
 * unsupported has no connection to lose, and one already awaiting auth is
 * where we want it.
 */
const INTERRUPTIBLE: readonly DomainState[] = [
  'ingesting',
  'needs_confirmation',
  'ready_for_planning',
]

export interface ConnectionLostResult {
  readonly accountId: string
  /** False when the connection was already known to be broken. */
  readonly changed: boolean
  readonly invalidatedAt: Date
}

/**
 * The single path both a rejected token and an uninstall take.
 *
 * The notification's dedupe key carries the moment the connection broke, so a
 * worker that runs twice cannot ring the bell twice — and a store that
 * reconnects and later breaks again *does* get a second notification, because
 * that is a different event.
 */
export async function recordConnectionLost(
  deps: ConnectionLifecycleDeps,
  input: { accountId: string; at: Date; attribution: EventAttribution },
): Promise<ConnectionLostResult> {
  const before = await deps.connections.read(input.accountId)
  const invalidatedAt = await deps.connections.markInvalid(input.accountId, input.at)
  const changed = before?.invalidatedAt == null

  await deps.domains.transition(input.accountId, INTERRUPTIBLE, 'awaiting_shopify_auth')

  await deps.notifications?.emit(
    'connection_lost_shopify',
    { shop_handle: before?.shopHandle ?? '' },
    `shopify:${invalidatedAt.toISOString()}`,
    input.attribution,
  )

  return { accountId: input.accountId, changed, invalidatedAt }
}

/**
 * Shopify's `app/uninstalled` webhook, once the receiver has verified it and
 * resolved which store it is about. Identical handling to a rejected token: the
 * token we hold is dead either way.
 *
 * Returns undefined when no account holds that shop — an uninstall for a store
 * that was never connected here, which is normal and not an error.
 */
export async function handleAppUninstalled(
  deps: ConnectionLifecycleDeps,
  input: { shopHandle: string; at: Date; attribution: (accountId: string) => EventAttribution },
): Promise<ConnectionLostResult | undefined> {
  const accountId = await deps.domains.findAccountByShopHandle(input.shopHandle)
  if (!accountId) return undefined
  return recordConnectionLost(deps, {
    accountId,
    at: input.at,
    attribution: input.attribution(accountId),
  })
}
