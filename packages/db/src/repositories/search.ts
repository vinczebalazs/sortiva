import { and, eq, isNull, ne, sql } from 'drizzle-orm'
import type { Db } from '../client'
import { gscConns, gscDaily, gscQueryDaily } from '../schema'
import type { AccountScope, SystemScope } from '../scope'

export type GscConnRow = typeof gscConns.$inferSelect

/**
 * A merchant's Search Console connection, and the two tables the search data
 * lands in.
 *
 * The connection row has a deliberate in-between state. Google's grant arrives
 * before the merchant has told us *which* of their properties this store is, and
 * both facts belong in the same row. So the row is written at the grant with an
 * empty property, and the property is filled in when they choose. Everything
 * that asks "is Search Console connected" treats an empty property as not
 * connected, which it is: we hold a key to a door nobody has pointed at yet.
 */

export async function findGscConnForAccount(
  db: Db,
  scope: AccountScope,
): Promise<GscConnRow | undefined> {
  const [row] = await db
    .select()
    .from(gscConns)
    .where(eq(gscConns.accountId, scope.accountId))
    .limit(1)
  return row
}

/**
 * Records a fresh grant. Reconnecting replaces the stored tokens and clears the
 * dead-grant marker, but leaves the chosen property alone — a merchant fixing a
 * broken connection is not asking to re-answer a question they already answered.
 */
export async function saveGscGrant(
  db: Db,
  scope: AccountScope,
  input: { tokens: string },
): Promise<GscConnRow> {
  const [row] = await db
    .insert(gscConns)
    .values({ accountId: scope.accountId, property: '', tokens: input.tokens })
    .onConflictDoUpdate({
      target: gscConns.accountId,
      set: { tokens: input.tokens, invalidatedAt: null },
    })
    .returning()
  if (!row) throw new Error('failed to record the Search Console grant')
  return row
}

/**
 * Fixes the property the merchant picked, and stamps the connection moment.
 *
 * `connected_at` is set here rather than at the grant because it is what the
 * performance chart is drawn from — "your search performance since connecting" —
 * and connecting, to a merchant, is the moment they finished choosing, not the
 * moment Google redirected them back.
 *
 * Guarded on the grant still being there: a merchant who disconnected in another
 * tab must not have a property written against a connection that no longer
 * exists.
 */
export async function selectGscProperty(
  db: Db,
  scope: AccountScope,
  input: { property: string; connectedAt: Date },
): Promise<GscConnRow | undefined> {
  const [row] = await db
    .update(gscConns)
    .set({ property: input.property, connectedAt: input.connectedAt, invalidatedAt: null })
    .where(eq(gscConns.accountId, scope.accountId))
    .returning()
  return row
}

/**
 * Records that the grant is gone. Reporting stops; nothing else does — the
 * content pipeline keeps running, because search reporting is an input to it,
 * never a dependency of it.
 *
 * Only the first such discovery moves the timestamp. That is what makes the
 * reconnect prompt land once instead of every time a sync retries.
 */
export async function markGscGrantInvalid(
  db: Db,
  scope: AccountScope,
  at: Date,
): Promise<GscConnRow | undefined> {
  const [row] = await db
    .update(gscConns)
    .set({ invalidatedAt: at })
    .where(and(eq(gscConns.accountId, scope.accountId), sql`${gscConns.invalidatedAt} is null`))
    .returning()
  return row
}

/**
 * Every account the nightly sync has something to fetch for: a property chosen
 * and a grant still alive. Crosses accounts by design — it is the sweep that
 * decides who to work for — so it takes a system scope, and each account's own
 * work is done under its own scope.
 */
export async function accountsWithLiveGscConnection(
  db: Db,
  _scope: SystemScope,
): Promise<string[]> {
  const rows = await db
    .select({ accountId: gscConns.accountId })
    .from(gscConns)
    .where(and(ne(gscConns.property, ''), isNull(gscConns.invalidatedAt)))
  return rows.map((row) => row.accountId)
}

export interface GscQueryDailyInput {
  readonly date: string
  readonly page: string
  readonly query: string
  readonly device: string
  readonly country: string
  readonly clicks: number
  readonly impressions: number
  readonly position: number | null
}

export interface GscDailyInput {
  readonly date: string
  readonly page: string
  readonly clicks: number
  readonly impressions: number
  readonly position: number | null
}

/**
 * Writes a batch of page-by-query rows, replacing any it already holds for the
 * same day, page, query, device and country.
 *
 * Replace rather than skip, because Google keeps revising recent days for about
 * a week and the later figure is the true one. It is also what makes the whole
 * import safe to redo: re-running a chunk that already landed writes the same
 * numbers over themselves rather than doubling them.
 */
export async function upsertGscQueryDaily(
  db: Db,
  scope: AccountScope,
  rows: readonly GscQueryDailyInput[],
): Promise<number> {
  if (rows.length === 0) return 0
  const values = rows.map((row) => ({
    accountId: scope.accountId,
    date: row.date,
    page: row.page,
    query: row.query,
    device: row.device,
    country: row.country,
    clicks: row.clicks,
    impressions: row.impressions,
    position: row.position === null ? null : row.position.toFixed(2),
  }))
  await db
    .insert(gscQueryDaily)
    .values(values)
    .onConflictDoUpdate({
      target: [
        gscQueryDaily.accountId,
        gscQueryDaily.date,
        gscQueryDaily.page,
        gscQueryDaily.query,
        gscQueryDaily.device,
        gscQueryDaily.country,
      ],
      set: {
        clicks: sql`excluded.clicks`,
        impressions: sql`excluded.impressions`,
        position: sql`excluded.position`,
      },
    })
  return values.length
}

/** Page-level totals for the same days, on the same replace-rather-than-skip terms. */
export async function upsertGscDaily(
  db: Db,
  scope: AccountScope,
  rows: readonly GscDailyInput[],
): Promise<number> {
  if (rows.length === 0) return 0
  const values = rows.map((row) => ({
    accountId: scope.accountId,
    date: row.date,
    page: row.page,
    clicks: row.clicks,
    impressions: row.impressions,
    position: row.position === null ? null : row.position.toFixed(2),
  }))
  await db
    .insert(gscDaily)
    .values(values)
    .onConflictDoUpdate({
      target: [gscDaily.accountId, gscDaily.date, gscDaily.page],
      set: {
        clicks: sql`excluded.clicks`,
        impressions: sql`excluded.impressions`,
        position: sql`excluded.position`,
      },
    })
  return values.length
}
