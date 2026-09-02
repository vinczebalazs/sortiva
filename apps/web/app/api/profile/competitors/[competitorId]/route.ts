import { withAccount } from '../../../auth/_lib/session'
import { makeRemoveCompetitorHandler, profileDeps } from '../../_lib/handlers'

/** Removing a competitor, which frees one of the five slots. */
export const dynamic = 'force-dynamic'

export const DELETE = withAccount(makeRemoveCompetitorHandler(profileDeps()))
