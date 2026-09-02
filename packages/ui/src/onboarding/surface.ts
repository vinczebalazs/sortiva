import type { ShellAccount } from '../shell'
import type { IngestionStatus } from './steps'

/**
 * Which onboarding surface the dashboard is showing.
 *
 * There is no wizard route in this product. The dashboard is the container for
 * every stage of setting a store up, and what it draws is decided by the state
 * of the domain rather than by where the merchant navigated — so closing the
 * tab and coming back lands them exactly where they left off, and a bookmarked
 * link never points at a step that is over.
 *
 * This function is the whole of that decision. Keeping it out of the page means
 * a state can be exercised in a test by describing an account rather than by
 * driving a browser through six screens to reach it.
 */

export type OnboardingSurface =
  /** No domain yet: the address field. */
  | 'connect_domain'
  /** The store is not on Shopify, and support has to unpark it. */
  | 'parked_unsupported'
  /** We had a Shopify connection and lost it: read access stays, work stops. */
  | 'parked_shopify_disconnected'
  /** Ingestion is waiting for the first Shopify grant; nothing else can run. */
  | 'shopify_blocking'
  /** The run is in flight: the seven-row progress list. */
  | 'ingesting'
  /** Everything is drafted and waiting to be confirmed. */
  | 'confirmation'
  /** Confirmed, and the first opportunity run has not produced anything yet. */
  | 'finding_opportunities'
  /**
   * Onboarding is over. The steady-state dashboard is a separate screen with
   * its own card; this surface exists so that the page can tell the difference
   * rather than guessing from a missing case.
   */
  | 'complete'

export interface SurfaceInput {
  readonly account: ShellAccount
  /** The ingestion run, when one is being followed. */
  readonly status?: IngestionStatus | null
}

/**
 * Whether the run is currently held at the Shopify grant.
 *
 * The domain state alone cannot answer this: a store that has never connected
 * and a store whose token was revoked both sit in `awaiting_shopify_auth`, and
 * the two want opposite screens — one is a step in setting up, the other is a
 * working account that stopped. The connection tells them apart: `broken`
 * means we had a token and lost it.
 */
function shopifyWasLost(account: ShellAccount): boolean {
  return account.connections.shopify === 'broken'
}

export function resolveOnboardingSurface({ account, status }: SurfaceInput): OnboardingSurface {
  const state = account.domain?.state ?? 'none'

  if (state === 'unsupported') return 'parked_unsupported'
  if (shopifyWasLost(account)) return 'parked_shopify_disconnected'

  switch (state) {
    case 'none':
      return 'connect_domain'
    case 'awaiting_shopify_auth':
      return 'shopify_blocking'
    case 'needs_confirmation':
      return 'confirmation'
    case 'ready_for_planning':
      // The account response carries no "the first scan finished" flag; the
      // scan timestamp is the same fact, and it is what the navigation rail
      // already reads to decide whether Opportunities is still filling.
      return account.connections.lastScanAt === null ? 'finding_opportunities' : 'complete'
    case 'ingesting':
      // A run that stalls at the grant reports it as a step rather than by
      // changing the domain's state, so the steps are worth a look before
      // drawing a progress list nothing is moving.
      return status?.steps.some((step) => step.step === 'oauth_wait' && step.state === 'running')
        ? 'shopify_blocking'
        : 'ingesting'
    default:
      return 'ingesting'
  }
}

/** True while the surface is one of the setup stages rather than the product proper. */
export function isOnboarding(surface: OnboardingSurface): boolean {
  return surface !== 'complete'
}
