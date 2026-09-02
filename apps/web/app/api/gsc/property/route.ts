import { withAccount } from '../../auth/_lib/session'
import { gscSelectPropertyHandler } from '../_lib/handlers'

/**
 * The merchant chooses their property. A property for a different website is
 * refused rather than warned about: everything the engine later concludes would
 * be about the wrong site, with nothing in the product to reveal it.
 *
 * Choosing is also what starts the import of the store's search history.
 */
export const dynamic = 'force-dynamic'

export const POST = withAccount(gscSelectPropertyHandler)
