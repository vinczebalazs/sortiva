import { makePerformanceStore } from '@sortiva/db'
import type { PerformanceDeps } from './handlers'

/**
 * Built per request, never at module load.
 *
 * The store resolves its database handle on the call rather than on
 * construction, and Next's build step evaluates every route module without a
 * database URL necessarily present. Constructing eagerly here is what turns a
 * green build into one whose every route answers 500. The pool itself is
 * memoized, so building this per request costs nothing.
 */
export function performanceDeps(): PerformanceDeps {
  return { store: makePerformanceStore() }
}
