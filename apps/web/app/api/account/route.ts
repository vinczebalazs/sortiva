import { withAccount } from '../auth/_lib/session'
import { accountRouteHandler } from './_lib/handler'

/**
 * main §4.3 — "auth ≠ domain connected". The dashboard shell asks this route
 * whether a domain exists; with `domain: null` it renders the single
 * "Connect your domain" empty state and locks everything else.
 *
 * Reads are never gated on billing state (invariant 16), so this route carries
 * no entitlement check.
 */
export const dynamic = 'force-dynamic'

export const GET = withAccount(accountRouteHandler)
