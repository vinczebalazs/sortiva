import { withAccount } from '../../auth/_lib/session'
import { makeConfirmProfileHandler, profileDeps } from '../_lib/handlers'

/**
 * "Confirm profile" — moves the account to `ready_for_planning` and ends
 * onboarding (main §6.8). The first opportunity run this unblocks (main §6.9)
 * is a later card's to start.
 */
export const dynamic = 'force-dynamic'

export const POST = withAccount(makeConfirmProfileHandler(profileDeps()))
