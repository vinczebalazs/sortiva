import { db, makeProfileStore } from '@sortiva/db'
import type { ProductsDeps } from './handlers'

/**
 * Built per request, never at module load.
 *
 * `db()` opens a connection pool, and Next's build step evaluates every route
 * module without a database URL necessarily present. Constructing this eagerly
 * turned `pnpm build` into a green build whose every route answered 500. The
 * pool itself is memoized, so building it here costs nothing per request.
 */
export function productsDeps(): ProductsDeps {
  return { db: db(), profile: makeProfileStore() }
}
