import { withAccount } from '../auth/_lib/session'
import { libraryDeps } from './_lib/config'
import { makeListArticlesHandler } from './_lib/library'

/**
 * `GET /api/articles` — everything this store has had written, newest first.
 */
export const dynamic = 'force-dynamic'

// `libraryDeps()` deferred to request time — see the note in `_lib/config.ts`.
export const GET = withAccount((request, context) => makeListArticlesHandler(libraryDeps())(request, context))
