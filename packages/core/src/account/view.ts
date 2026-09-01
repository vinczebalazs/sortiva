import type { z } from 'zod'
import type { accountResponseSchema, domainStateSchema } from '../api/schemas'
import type { SubscriptionStatus } from '../billing/entitlement'

export type AccountView = z.infer<typeof accountResponseSchema>
export type DomainState = z.infer<typeof domainStateSchema>

/**
 * Of the four kill switches, these are the two that stop this account's work
 * outright. `global.pause_publishing` / `account.pause_publishing`
 * stop a later stage and have their own surface, so they do not read as "the
 * service is paused" on the dashboard.
 */
export const SERVICE_PAUSED_FLAGS = ['global.pause_all', 'account.pause_generation'] as const

export interface AccountViewInput {
  readonly accountId: string
  readonly email: string
  /** Absent until the account has claimed a domain. */
  readonly domain: { normalized: string; state: DomainState; platform: string | null } | null
  /** Read from our own row; no request path ever calls Stripe. */
  readonly subscription: {
    // Imported rather than re-listed: this was a second copy of the status set,
    // and it went stale the moment the set gained `incomplete` (card T1.2a).
    status: SubscriptionStatus
    cancelAtPeriodEnd: boolean
    currentPeriodEnd: Date | null
  } | null
  /** Read scopes are granted at install; permission to publish is a separate, later grant. */
  readonly shopify: { grantedScopes: readonly string[]; invalidatedAt: Date | null } | null
  /** The `scope.flag` names currently tripped for this account. */
  readonly activeFlags: readonly string[]
}

/**
 * The dashboard's one question: am I signed in, and is a domain connected?
 * Everything else on this object exists so the shell can render
 * locked or empty without a second round trip.
 *
 * Two values are constant until later cards, and both are *correct* rather than
 * placeholders. Limited Intelligence means "no Search Console connected", and
 * nothing can connect Search Console before T3.1; and no scan can have run
 * before the detection runs exist at all.
 */
export function buildAccountView(input: AccountViewInput): AccountView {
  return {
    accountId: input.accountId,
    email: input.email,
    domain: input.domain
      ? {
          normalized: input.domain.normalized,
          state: input.domain.state,
          platform: input.domain.platform,
        }
      : null,
    subscription: {
      status: input.subscription?.status ?? 'none',
      cancelAtPeriodEnd: input.subscription?.cancelAtPeriodEnd ?? false,
      currentPeriodEnd: input.subscription?.currentPeriodEnd?.toISOString() ?? null,
    },
    limitedIntelligence: true,
    connections: {
      shopify: shopifyConnectionState(input.shopify),
      searchConsole: 'none',
      lastScanAt: null,
    },
    servicePaused: SERVICE_PAUSED_FLAGS.some((flag) => input.activeFlags.includes(flag)),
  }
}

/**
 * Reading a store and writing to it are separate consents, so the UI has to
 * distinguish "connected, read only" from "connected, can publish" — a merchant
 * must never discover we can post to their blog by seeing a post appear. A
 * rejected token invalidates the row.
 */
function shopifyConnectionState(
  conn: AccountViewInput['shopify'],
): AccountView['connections']['shopify'] {
  if (!conn) return 'none'
  if (conn.invalidatedAt) return 'broken'
  return conn.grantedScopes.includes('write_content') ? 'read_write' : 'read'
}
