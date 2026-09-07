import { withAccount } from '../../auth/_lib/session'
import { productsDeps } from '../_lib/config'
import { makeGetFamiliesHandler } from '../_lib/handlers'

/**
 * `GET /api/products/families` — the family list, read-only by design. The only
 * thing a merchant can do to a grouping is tell us it is wrong, which is the
 * sibling `POST /api/products/families/report`.
 */
export const dynamic = 'force-dynamic'

// Resolved per request, not at module scope — see `_lib/config.ts`.
export const GET = withAccount((request, context) =>
  makeGetFamiliesHandler(productsDeps())(request, context),
)
