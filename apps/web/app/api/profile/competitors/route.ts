import { withAccount } from '../../auth/_lib/session'
import { makeAddCompetitorHandler, profileDeps } from '../_lib/handlers'

/**
 * Adding a competitor by hand. Capped at five in this route and, independently,
 * in the database — the database being the one that holds when two requests
 * arrive at the same instant.
 */
export const dynamic = 'force-dynamic'

export const POST = withAccount(makeAddCompetitorHandler(profileDeps()))
