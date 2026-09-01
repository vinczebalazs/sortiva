import type { RequestCache, RequestCacheEntry } from '@sortiva/core'
import type { Db } from './client'
import { putBeforeProcessing, readCachedRequest } from './repositories/system'
import { systemScope } from './scope'

/**
 * The production adapter for the request-level cache on paid vendor calls.
 * Backed by the `request_cache` table: there is no Redis in v1, so Postgres is
 * the cache.
 *
 * The scope is a system scope because the row is keyed by canonical request
 * params, not by tenant: two accounts asking DataForSEO the same question share
 * the answer, which is the point of a billable-read cache.
 */
export class PostgresRequestCache implements RequestCache {
  private readonly scope = systemScope(
    'request_cache is keyed on canonical request params, not on an account',
  )

  constructor(private readonly db: Db) {}

  async read(cacheKey: string): Promise<RequestCacheEntry | undefined> {
    const row = await readCachedRequest(this.db, this.scope, cacheKey)
    if (!row) return undefined
    return {
      cacheKey: row.cacheKey,
      kind: row.kind,
      responseJson: row.responseJson,
      expiresAt: row.expiresAt,
    }
  }

  async writeBeforeProcessing(entry: RequestCacheEntry): Promise<void> {
    await putBeforeProcessing(this.db, this.scope, {
      cacheKey: entry.cacheKey,
      kind: entry.kind,
      responseJson: entry.responseJson,
      expiresAt: entry.expiresAt,
    })
  }
}
