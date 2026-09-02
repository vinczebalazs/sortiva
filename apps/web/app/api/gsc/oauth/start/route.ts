import { withAccount } from '../../../auth/_lib/session'
import { gscStartHandler } from '../../_lib/handlers'

/**
 * Begins the Search Console connection. A second, separate consent from signing
 * in: signing in asks Google who the merchant is, this asks to read their search
 * data, and neither can ever change anything in their property.
 *
 * Not gated on billing state — reading is never gated on billing.
 */
export const dynamic = 'force-dynamic'

export const POST = withAccount(gscStartHandler)
