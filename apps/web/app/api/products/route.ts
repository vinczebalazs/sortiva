import { withAccount } from '../auth/_lib/session'
import { productsDeps } from './_lib/config'
import { makeGetProductsHandler } from './_lib/handlers'

/**
 * `GET /api/products` — the Store Intelligence layer made visible: how much the
 * catalogue actually says, the knowledge gaps holding work up, and the product
 * table itself.
 */
export const dynamic = 'force-dynamic'

// `productsDeps()` is resolved inside the request, not at module scope — see
// the note in `_lib/config.ts` for the build failure that pattern avoids.
export const GET = withAccount((request, context) =>
  makeGetProductsHandler(productsDeps())(request, context),
)
