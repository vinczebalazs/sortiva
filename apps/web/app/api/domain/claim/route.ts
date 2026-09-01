import { withAccount } from '../../auth/_lib/session'
import { claimHandler } from '../_lib/handler'

/**
 * The merchant connects their store. One domain per account and one account per
 * domain are decided by the database's unique indexes inside a transaction, not
 * by anything this route can see.
 *
 * Not gated on billing state: billing gates generation and publishing, and the
 * signup flow puts Checkout before this screen anyway.
 */
export const dynamic = 'force-dynamic'

export const POST = withAccount(claimHandler)
