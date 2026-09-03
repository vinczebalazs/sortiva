import { withAccount } from '../auth/_lib/session'
import { makeGetProfileHandler, profileDeps } from './_lib/handlers'

/**
 * The confirmation screen's whole read, and — once confirmed — the same read
 * behind Settings → Store profile (main §6.8, ui §9.2).
 */
export const dynamic = 'force-dynamic'

export const GET = withAccount(makeGetProfileHandler(profileDeps()))
