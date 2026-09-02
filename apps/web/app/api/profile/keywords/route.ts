import { withAccount } from '../../auth/_lib/session'
import { makeAddKeywordHandler, profileDeps } from '../_lib/handlers'

/**
 * Adding a search term by hand. The row appears unpriced and the vendor lookup
 * runs on the queue's high-priority lane, so the merchant is never waiting on a
 * third party inside their own form.
 */
export const dynamic = 'force-dynamic'

export const POST = withAccount(makeAddKeywordHandler(profileDeps()))
