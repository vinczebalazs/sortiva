import { withAccount } from '../../auth/_lib/session'
import { claimHandler } from '../_lib/handler'

/**
 * main §5, ui §3.1 — the merchant connects their store. One domain per account
 * and one account per domain (invariant 1) are decided by the database's unique
 * indexes inside a transaction, not by anything this route can see.
 *
 * Not gated on billing state: invariant 16 gates generation and publishing, and
 * main §4.2's flow puts Checkout before this screen anyway.
 */
export const dynamic = 'force-dynamic'

export const POST = withAccount(claimHandler)
