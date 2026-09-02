import { withAccount } from '../../auth/_lib/session'
import { deleteAccountHandler } from './_lib/handler'

/**
 * Deleting the account. Irreversible, and deliberately not gated on billing
 * state — a merchant whose payment failed is exactly the one most likely to
 * want out.
 */
export const dynamic = 'force-dynamic'

export const POST = withAccount(deleteAccountHandler)
