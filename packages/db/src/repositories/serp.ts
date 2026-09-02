import { and, eq, gt, inArray, sql } from 'drizzle-orm'
import type { Db } from '../client'
import { serpSnapshots } from '../schema'
import type { SystemScope } from '../scope'

/**
 * Who ranks for a search, stored for a week.
 *
 * **This is the only place a ranking domain lives.** It is not a competitor
 * list and nothing here can become one: the rows carry no account, they are not
 * editable by anybody, and the merchant never sees them as a list. What the
 * merchant may see is a *count* computed over them — "this domain ranks
 * alongside you in eight of your searches, add?" — and adding is their click on
 * a route that writes to `competitors` with a `source`.
 *
 * No `account_id`, deliberately. A snapshot is keyed on the canonical request
 * that bought it, so two stores in the same market asking about the same search
 * share one purchase instead of making us pay the vendor twice. That is why
 * these functions take a `SystemScope` carrying a written reason rather than an
 * account.
 *
 * The seven-day lifetime is the product's memory of a results page; the
 * vendor's own 24-hour request cache sits underneath it and exists only to make
 * a crashed step's retry free.
 */

export type SerpSnapshotRow = typeof serpSnapshots.$inferSelect

/** One organic result, as stored. Position, address and the domain that owns it. */
export interface SerpSnapshotResult {
  readonly position: number
  readonly url: string
  readonly domain: string
  readonly title: string | null
}

export interface SerpSnapshotWrite {
  readonly cacheKey: string
  readonly query: string
  /** `<language>-<COUNTRY>`, e.g. `da-DK`. Two markets' answers to one search are two different snapshots. */
  readonly locale: string
  readonly results: readonly SerpSnapshotResult[]
  readonly fetchedAt: Date
  readonly expiresAt: Date
}

/**
 * Stores a results page, replacing an older one for the same canonical request.
 *
 * Replace rather than keep-both: a results page is a reading of one moment, and
 * two readings under one key would leave "who ranks for this" ambiguous at
 * exactly the point something is deciding what to write.
 */
export async function upsertSerpSnapshot(
  db: Db,
  _scope: SystemScope,
  input: SerpSnapshotWrite,
): Promise<void> {
  const values = {
    cacheKey: input.cacheKey,
    query: input.query,
    locale: input.locale,
    resultsJson: input.results,
    fetchedAt: input.fetchedAt,
    expiresAt: input.expiresAt,
  }
  await db
    .insert(serpSnapshots)
    .values(values)
    .onConflictDoUpdate({ target: serpSnapshots.cacheKey, set: values })
}

/**
 * A stored results page, if one is still inside its lifetime.
 *
 * Expiry is checked in the query rather than by the caller, so a stale snapshot
 * can never be read by accident. That matters more than it looks: a topic
 * decision made on last month's results page is the one degradation the product
 * refuses outright — it pauses instead.
 */
export async function findFreshSerpSnapshot(
  db: Db,
  _scope: SystemScope,
  cacheKey: string,
  now: Date,
): Promise<SerpSnapshotRow | undefined> {
  const [row] = await db
    .select()
    .from(serpSnapshots)
    .where(and(eq(serpSnapshots.cacheKey, cacheKey), gt(serpSnapshots.expiresAt, now)))
    .limit(1)
  return row
}

/** Every unexpired snapshot among the given keys, for a caller reading a whole set of searches at once. */
export async function findFreshSerpSnapshots(
  db: Db,
  _scope: SystemScope,
  cacheKeys: readonly string[],
  now: Date,
): Promise<SerpSnapshotRow[]> {
  if (cacheKeys.length === 0) return []
  return db
    .select()
    .from(serpSnapshots)
    .where(
      and(inArray(serpSnapshots.cacheKey, [...cacheKeys]), gt(serpSnapshots.expiresAt, now)),
    )
}

/** Drops snapshots past their lifetime. Called by the retention sweep; returns how many went. */
export async function pruneExpiredSerpSnapshots(
  db: Db,
  _scope: SystemScope,
  now: Date,
): Promise<number> {
  const removed = await db
    .delete(serpSnapshots)
    .where(sql`${serpSnapshots.expiresAt} <= ${now}`)
    .returning({ cacheKey: serpSnapshots.cacheKey })
  return removed.length
}

/** One domain seen ranking for one search: the shape the candidate ranking reads. */
export interface RankedDomainRow {
  readonly keyword: string
  readonly domain: string
  readonly position: number
}

/**
 * Who ranks for each of a set of searches, read out of whatever fresh snapshots
 * we hold.
 *
 * This is the whole of the read path from stored results pages to anything a
 * merchant sees, and note what it returns: flat rows, no identity, no way to
 * write. What the caller does with them is count how many of the store's own
 * searches each domain turns up for, which is the only claim we make about a
 * ranking domain. Searches we hold no fresh page for simply contribute nothing
 * — a suggestion computed from stale rankings would be worse than no
 * suggestion.
 */
export async function rankedDomainsForQueries(
  db: Db,
  scope: SystemScope,
  input: { cacheKeys: readonly string[]; now: Date },
): Promise<RankedDomainRow[]> {
  const rows = await findFreshSerpSnapshots(db, scope, input.cacheKeys, input.now)
  return rows.flatMap((row) =>
    resultsOf(row).map((result) => ({
      keyword: row.query,
      domain: result.domain,
      position: result.position,
    })),
  )
}

/** The results as stored, typed. The column is JSON, so this is where the shape is re-asserted. */
export function resultsOf(row: SerpSnapshotRow): SerpSnapshotResult[] {
  const raw = row.resultsJson
  return Array.isArray(raw) ? (raw as SerpSnapshotResult[]) : []
}
