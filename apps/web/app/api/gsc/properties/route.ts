import { withAccount } from '../../auth/_lib/session'
import { gscPropertiesHandler } from '../_lib/handlers'

/**
 * The property picker's contents: every Search Console property this Google
 * account can read, each flagged for whether it is the store we claimed. Both
 * kinds Google offers are accepted.
 *
 * Returning the mismatched ones too is deliberate — a merchant who sees only an
 * empty list learns nothing about why their property is missing.
 */
export const dynamic = 'force-dynamic'

export const GET = withAccount(gscPropertiesHandler)
