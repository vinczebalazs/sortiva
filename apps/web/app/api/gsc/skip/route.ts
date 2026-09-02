import { withAccount } from '../../auth/_lib/session'
import { gscSkipHandler } from '../_lib/handlers'

/**
 * The merchant would rather not connect Search Console. A first-class answer,
 * not a failure: the onboarding step records it and the rest of onboarding
 * carries on. The account then runs on what its catalogue and the market can
 * tell us, and says so, until Search Console is connected.
 */
export const dynamic = 'force-dynamic'

export const POST = withAccount(gscSkipHandler)
